import { useEffect, useState } from 'react'
import { useBackup } from '../store'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function BackupView(): React.JSX.Element {
  const { backups, loading, busy, error, load, create, restore, remove, reveal } = useBackup()
  const [label, setLabel] = useState('')
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => { void load() }, [load])

  const handleCreate = async (): Promise<void> => {
    await create(label.trim() || undefined)
    setLabel('')
    setNotice('备份已创建')
    setTimeout(() => setNotice(null), 3000)
  }

  const handleRestore = async (id: string): Promise<void> => {
    const ok = await restore(id)
    setConfirmRestore(null)
    if (ok) {
      setNotice('已恢复，请重启应用以确保所有数据生效')
      setTimeout(() => setNotice(null), 6000)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">备份 / 恢复</h2>
          <p className="text-xs text-slate-400 mt-0.5">导出全部环境、代理、账号配置为备份文件，可随时恢复</p>
        </div>
        <div className="flex items-center gap-2">
          <input className="input !w-40" placeholder="备注（可选）" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn btn-ghost" onClick={() => void reveal()}>打开目录</button>
          <button className="btn btn-primary" onClick={() => void handleCreate()} disabled={busy}>{busy ? '备份中...' : '+ 立即备份'}</button>
        </div>
      </div>
      {error && <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>}
      {notice && <div className="mx-6 mt-4 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-4 py-2 text-sm text-emerald-300 animate-fade-in">{notice}</div>}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="text-center text-slate-500 py-12">加载中...</div>
        ) : backups.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">💾</div>
            <p className="text-slate-400">暂无备份</p>
            <p className="text-xs text-slate-500 mt-1">点击「立即备份」创建第一份备份</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                  <th className="px-4 py-3">名称</th>
                  <th className="px-4 py-3">大小</th>
                  <th className="px-4 py-3">创建时间</th>
                  <th className="px-4 py-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id} className="border-t border-[#1e293b] hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{b.name}</td>
                    <td className="px-4 py-3 text-slate-400">{fmtBytes(b.sizeBytes)}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{new Date(b.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        {confirmRestore === b.id ? (
                          <>
                            <span className="text-xs text-amber-300 self-center">恢复会覆盖当前数据</span>
                            <button className="btn btn-danger btn-xs" onClick={() => void handleRestore(b.id)}>确认恢复</button>
                            <button className="btn btn-ghost btn-xs" onClick={() => setConfirmRestore(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-secondary btn-xs" onClick={() => setConfirmRestore(b.id)}>恢复</button>
                            <button className="btn btn-ghost btn-xs text-rose-400 hover:text-rose-300" onClick={() => void remove(b.id)}>删除</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
