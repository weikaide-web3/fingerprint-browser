import { useEffect, useState } from 'react'
import { useTrash } from '../store'
import type { TrashKind } from '@shared/ops'

const KIND_LABEL: Record<TrashKind, string> = {
  profile: '环境',
  proxy: '代理',
  extension: '扩展'
}

const KIND_ICON: Record<TrashKind, string> = {
  profile: '🌐',
  proxy: '🔀',
  extension: '🧩'
}

export default function TrashView(): React.JSX.Element {
  const { items, loading, error, load, restore, purge, empty } = useTrash()
  const [tab, setTab] = useState<TrashKind | 'all'>('all')
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const shown = tab === 'all' ? items : items.filter((i) => i.kind === tab)
  const counts: Record<TrashKind, number> = {
    profile: items.filter((i) => i.kind === 'profile').length,
    proxy: items.filter((i) => i.kind === 'proxy').length,
    extension: items.filter((i) => i.kind === 'extension').length
  }

  const tabs: { key: TrashKind | 'all'; label: string }[] = [
    { key: 'all', label: `全部 (${items.length})` },
    { key: 'profile', label: `环境 (${counts.profile})` },
    { key: 'proxy', label: `代理 (${counts.proxy})` },
    { key: 'extension', label: `扩展 (${counts.extension})` }
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">回收站</h2>
          <p className="text-xs text-slate-400 mt-0.5">删除的环境 / 代理 / 扩展会先进入这里，可恢复或彻底删除</p>
        </div>
        {items.length > 0 && (
          confirmEmpty ? (
            <div className="flex gap-2">
              <button className="btn btn-danger btn-sm" onClick={() => { void empty(); setConfirmEmpty(false) }}>确认清空</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmEmpty(false)}>取消</button>
            </div>
          ) : (
            <button className="btn btn-ghost btn-sm text-rose-400 hover:text-rose-300" onClick={() => setConfirmEmpty(true)}>
              🗑 清空回收站
            </button>
          )
        )}
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>
      )}

      <div className="px-6 pt-4 flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`btn btn-sm ${tab === t.key ? 'btn-primary' : 'btn-ghost'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="text-center text-slate-500 py-12">加载中...</div>
        ) : shown.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🗑️</div>
            <p className="text-slate-400">回收站是空的</p>
            <p className="text-xs text-slate-500 mt-1">删除环境、代理或扩展后，它们会先移到这里，可随时恢复</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                  <th className="px-4 py-3">名称</th>
                  <th className="px-4 py-3">类型</th>
                  <th className="px-4 py-3">信息</th>
                  <th className="px-4 py-3">删除时间</th>
                  <th className="px-4 py-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((it) => (
                  <tr key={`${it.kind}:${it.id}`} className="border-t border-[#1e293b] hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-white">{it.name}</td>
                    <td className="px-4 py-3 text-slate-400">
                      <span className="inline-flex items-center gap-1.5">
                        <span>{KIND_ICON[it.kind]}</span>
                        {KIND_LABEL[it.kind]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 truncate max-w-[240px]">{it.meta ?? '-'}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {it.deletedAt ? new Date(it.deletedAt).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        <button className="btn btn-secondary btn-xs" onClick={() => void restore(it.kind, it.id)}>恢复</button>
                        {confirmPurge === `${it.kind}:${it.id}` ? (
                          <>
                            <button className="btn btn-danger btn-xs" onClick={() => { void purge(it.kind, it.id); setConfirmPurge(null) }}>彻底删除</button>
                            <button className="btn btn-ghost btn-xs" onClick={() => setConfirmPurge(null)}>取消</button>
                          </>
                        ) : (
                          <button className="btn btn-ghost btn-xs text-rose-400 hover:text-rose-300" onClick={() => setConfirmPurge(`${it.kind}:${it.id}`)}>删除</button>
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