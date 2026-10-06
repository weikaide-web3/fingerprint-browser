import { useEffect, useState } from 'react'
import { useApp, exportProfileBundle, importProfileBundle } from '../store'
import CreateProfileDialog from './CreateProfileDialog'
import Pagination from './Pagination'
import type { Profile } from '@shared/types'
import type { ProfileBundle } from '@shared/ops'

export const STATUS_LABEL: Record<string, string> = {
  stopped: '未运行',
  starting: '启动中',
  running: '运行中',
  error: '异常'
}

export const STATUS_STYLE: Record<string, string> = {
  stopped: 'bg-slate-700/50 text-slate-400 border-slate-600/40',
  starting: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  running: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  error: 'bg-rose-500/15 text-rose-300 border-rose-500/25'
}

function fingerprintSummary(p: Profile): string {
  const fp = p.fingerprint
  if (!fp) return '—'
  return `Chrome ${fp.ua.major} · ${fp.screen.width}×${fp.screen.height} · ${fp.timezone.id} · ${fp.hardware.hardwareConcurrency}C/${fp.hardware.deviceMemory}G`
}

export default function ProfilesView(): React.JSX.Element {
  const { profiles, groups, loading, error, filter, page, pageSize, total, load, setFilter, setPage, setPageSize, remove, duplicate, regenerate, start, stop, stopAll, openDetail } = useApp()
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  useEffect(() => {
    const onNew = (): void => setCreating(true)
    window.addEventListener('fpb:new-profile', onNew)
    return () => window.removeEventListener('fpb:new-profile', onNew)
  }, [])

  const toggleSelect = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const allSelected = profiles.length > 0 && selected.length === profiles.length
  const toggleSelectAll = (): void =>
    setSelected(allSelected ? [] : profiles.map((p) => p.id))

  const batchStart = async (): Promise<void> => { for (const id of selected) await start(id) }
  const batchStop = async (): Promise<void> => { for (const id of selected) await stop(id) }
  const batchDelete = async (): Promise<void> => {
    if (!confirm(`确认删除 ${selected.length} 个环境？删除后可在「回收站」恢复。`)) return
    for (const id of selected) await remove(id)
    setSelected([])
  }

  const exportOne = async (p: Profile): Promise<void> => {
    try {
      const bundle = await exportProfileBundle(p.id)
      await window.api.app.saveText(`${p.name}.fpb.json`, JSON.stringify(bundle, null, 2))
    } catch (e) {
      alert(`导出失败：${(e as Error).message}`)
    }
  }

  const importBundle = async (): Promise<void> => {
    const picked = await window.api.app.pickText()
    if (!picked) return
    try {
      const bundle = JSON.parse(picked.content) as ProfileBundle
      if (bundle.version !== 1 || !bundle.profile) throw new Error('文件格式不正确')
      const r = await importProfileBundle(bundle)
      alert(`已导入环境「${r.name}」${r.proxyCreated ? '（含代理）' : ''}`)
    } catch (e) {
      alert(`导入失败：${(e as Error).message}`)
    }
  }

  // 当前分组下所有环境一键打开（按当前页）
  const openGroup = async (): Promise<void> => {
    for (const p of profiles) if (p.status !== 'running') await start(p.id)
  }

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <button onClick={() => setCreating(true)} className="btn btn-primary">
          <span className="text-base leading-none">+</span> 新建环境
        </button>
        <input value={filter.search ?? ''} onChange={(e) => setFilter({ search: e.target.value })} placeholder="搜索环境名称 / 备注" className="input w-56" />
        <select value={filter.groupId ?? ''} onChange={(e) => setFilter({ groupId: e.target.value || null })} className="input w-32">
          <option value="">全部分组</option>
          {groups.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
        </select>
        {selected.length > 0 && (
          <div className="flex items-center gap-2 animate-fade-in">
            <button onClick={batchStart} className="btn btn-sm btn-secondary">▶ 批量打开 ({selected.length})</button>
            <button onClick={batchStop} className="btn btn-sm btn-secondary">■ 批量关闭</button>
            <button onClick={() => void batchDelete()} className="btn btn-sm btn-danger">🗑 批量删除</button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {filter.groupId && <button onClick={() => void openGroup()} className="btn btn-sm btn-secondary">▶ 打开本组</button>}
          <button onClick={() => void importBundle()} className="btn btn-sm btn-ghost">导入</button>
          <button onClick={stopAll} className="btn btn-sm btn-ghost">全部关闭</button>
          <button onClick={() => void load()} className="btn btn-sm btn-ghost">↻ 刷新</button>
        </div>
      </header>

      {error && <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-4 py-2.5 text-sm text-rose-200 animate-fade-in">{error}</div>}

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th className="w-10"><input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="全选" /></th>
                <th>环境名称</th>
                <th>状态</th>
                <th>指纹摘要</th>
                <th>代理</th>
                <th>最后打开</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className="animate-fade-in">
                  <td><input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggleSelect(p.id)} /></td>
                  <td>
                    <button onClick={() => openDetail(p.id)} className="font-medium text-slate-100 hover:text-emerald-300 transition-colors text-left">{p.name}</button>
                    {p.note && <div className="text-[11px] text-slate-500 mt-0.5">{p.note}</div>}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_STYLE[p.status]}`}>
                      {p.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />}
                      {STATUS_LABEL[p.status]}
                    </span>
                  </td>
                  <td className="text-xs text-slate-400">{fingerprintSummary(p)}</td>
                  <td className="text-xs text-slate-400">{p.proxy ? `${p.proxy.scheme}://${p.proxy.host}:${p.proxy.port}` : <span className="text-slate-600">直连</span>}</td>
                  <td className="text-xs text-slate-400">{p.lastOpenedAt ? new Date(p.lastOpenedAt).toLocaleString() : <span className="text-slate-600">从未</span>}</td>
                  <td className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <button onClick={() => openDetail(p.id)} className="btn btn-xs btn-ghost">详情</button>
                      {p.status === 'running' ? (
                        <button onClick={() => void stop(p.id)} className="btn btn-xs btn-ghost text-amber-300 hover:text-amber-200">停止</button>
                      ) : (
                        <button onClick={() => void start(p.id)} className="btn btn-xs btn-ghost text-emerald-300 hover:text-emerald-200">打开</button>
                      )}
                      <button onClick={() => void duplicate(p.id)} className="btn btn-xs btn-ghost">复制</button>
                      <button onClick={() => void regenerate(p.id)} className="btn btn-xs btn-ghost">换指纹</button>
                      <button onClick={() => void exportOne(p)} className="btn btn-xs btn-ghost">导出</button>
                      <button onClick={() => { if (confirm(`删除环境「${p.name}」？删除后可在「回收站」恢复。`)) void remove(p.id) }} className="btn btn-xs btn-ghost text-rose-400 hover:text-rose-300">删除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {profiles.length === 0 && (
                <tr><td colSpan={7}>
                  <div className="empty-state">
                    <div className="empty-state-icon">🌐</div>
                    <div className="text-sm">{loading ? '加载中…' : '还没有环境'}</div>
                    {!loading && <div className="text-xs mt-1">点击「新建环境」开始创建你的第一个浏览器环境</div>}
                  </div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
      </div>

      {creating && <CreateProfileDialog onClose={() => setCreating(false)} />}
    </>
  )
}
