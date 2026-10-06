import { useEffect, useState } from 'react'
import { useExtensions, useApp } from '../store'
import Pagination from './Pagination'
import type { ExtensionRecord } from '@shared/types'

export default function ExtensionsView(): React.JSX.Element {
  const { extensions, usage, loading, error, busy, load, install, installStore, uninstall, toggle } = useExtensions()
  const { profiles } = useApp()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [bindTarget, setBindTarget] = useState<ExtensionRecord | null>(null)
  const [storeDialog, setStoreDialog] = useState(false)

  useEffect(() => { void load() }, [load])

  const total = extensions.length
  const paged = extensions.slice((page - 1) * pageSize, page * pageSize)

  const handleInstall = async (): Promise<void> => {
    const dir = await window.api.app.pickDirectory()
    if (!dir) return
    await install(dir)
  }

  const handleUninstall = async (id: string): Promise<void> => {
    await uninstall(id)
    setConfirmDelete(null)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">扩展管理</h2>
          <p className="text-xs text-slate-400 mt-0.5">安装 Chrome 扩展（解包目录或应用商店），绑定到环境后自动加载</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={() => setStoreDialog(true)} disabled={busy}>
            从应用商店添加
          </button>
          <button className="btn btn-primary" onClick={handleInstall} disabled={busy}>
            {busy ? '处理中...' : '+ 安装解包扩展'}
          </button>
        </div>
      </div>
      {error && (
        <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>
      )}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="text-center text-slate-500 py-12">加载中...</div>
        ) : extensions.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🧩</div>
            <p className="text-slate-400">尚未安装任何扩展</p>
            <p className="text-xs text-slate-500 mt-1">「安装解包扩展」选择含 manifest.json 的目录；「从应用商店添加」粘贴商店链接</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                  <th className="px-4 py-3">名称</th>
                  <th className="px-4 py-3">来源</th>
                  <th className="px-4 py-3">版本</th>
                  <th className="px-4 py-3">绑定环境</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-4 py-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((ext) => {
                  const bound = usage[ext.id] ?? 0
                  const isStore = (ext.source ?? 'unpacked') === 'store'
                  return (
                    <tr key={ext.id} className="border-t border-[#1e293b] hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{ext.name}</div>
                        {ext.description && <div className="text-xs text-slate-500 mt-0.5 truncate max-w-[200px]">{ext.description}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={'badge ' + (isStore ? 'bg-sky-500/20 text-sky-300' : 'bg-slate-700/60 text-slate-300')}>
                          {isStore ? '应用商店' : '解包目录'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400">{ext.version ?? '-'}</td>
                      <td className="px-4 py-3">
                        <button className="text-emerald-400 hover:text-emerald-300 text-xs underline underline-offset-2" onClick={() => setBindTarget(ext)}>
                          {bound > 0 ? bound + ' 个环境' : '未绑定'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button className={'badge cursor-pointer ' + (ext.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700/60 text-slate-400')} onClick={() => void toggle(ext.id, !ext.enabled)}>
                          {ext.enabled ? '已启用' : '已禁用'}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {confirmDelete === ext.id ? (
                          <div className="inline-flex gap-2">
                            <button className="btn btn-danger btn-xs" onClick={() => void handleUninstall(ext.id)}>确认卸载</button>
                            <button className="btn btn-ghost btn-xs" onClick={() => setConfirmDelete(null)}>取消</button>
                          </div>
                        ) : (
                          <button className="btn btn-ghost btn-xs text-rose-400 hover:text-rose-300" onClick={() => setConfirmDelete(ext.id)}>卸载</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {total > 0 && <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} />}
      {bindTarget && <BindExtensionDialog extension={bindTarget} profiles={profiles} onClose={() => setBindTarget(null)} />}
      {storeDialog && <StoreInstallDialog onClose={() => setStoreDialog(false)} onSubmit={async (url, name) => { const r = await installStore(url, name); if (r) setStoreDialog(false); return r }} />}
    </div>
  )
}

function BindExtensionDialog({ extension, profiles, onClose }: {
  extension: ExtensionRecord
  profiles: { id: string; name: string }[]
  onClose(): void
}): React.JSX.Element {
  const { bind, unbind, installInProfile, load } = useExtensions()
  const isStore = (extension.source ?? 'unpacked') === 'store'
  const [bound, setBound] = useState<Set<string>>(new Set())
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<string | null>(null)

  useEffect(() => {
    if (isStore) {
      void window.api.extensions.storeStatus(extension.id).then((list) => {
        setBound(new Set(list.map((p) => p.profileId)))
        setInstalled(new Set(list.filter((p) => p.installed).map((p) => p.profileId)))
        setLoading(false)
      })
    } else {
      void window.api.extensions.boundProfiles(extension.id).then((list) => {
        setBound(new Set(list.map((p) => p.id)))
        setLoading(false)
      })
    }
  }, [extension.id, isStore])

  const toggleBind = async (profileId: string): Promise<void> => {
    if (bound.has(profileId)) { await unbind(extension.id, profileId) }
    else { await bind(extension.id, profileId) }
    setBound((prev) => { const n = new Set(prev); if (n.has(profileId)) n.delete(profileId); else n.add(profileId); return n })
    void load()
  }

  const installTo = async (profileId: string): Promise<void> => {
    setInstalling(profileId)
    const r = await installInProfile(extension.id, profileId)
    if (r) setBound((prev) => new Set(prev).add(profileId))
    setInstalling(null)
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-panel" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-white font-semibold mb-1">绑定扩展「{extension.name}」</h3>
        <p className="text-xs text-slate-400 mb-4">
          {isStore
            ? '商店扩展：点「安装到环境」会在该环境内打开商店页，点一次 Add to Chrome 即原生安装并跨重启保留。'
            : '勾选需要加载此扩展的环境，启动时自动注入。'}
        </p>
        {loading ? (
          <div className="text-slate-500 text-sm py-4">加载中...</div>
        ) : profiles.length === 0 ? (
          <div className="text-slate-500 text-sm py-4">暂无环境</div>
        ) : (
          <div className="max-h-[320px] overflow-auto space-y-1">
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-slate-800/50">
                {isStore ? (
                  <>
                    <span className="text-sm text-slate-200">{p.name}</span>
                    {installed.has(p.id) ? (
                      <span className="badge bg-emerald-500/20 text-emerald-300">✓ 已安装</span>
                    ) : bound.has(p.id) ? (
                      <span className="flex items-center gap-2">
                        <span className="badge bg-amber-500/20 text-amber-300">待安装</span>
                        <button className="btn btn-secondary btn-xs" onClick={() => void installTo(p.id)} disabled={installing === p.id}>
                          {installing === p.id ? '打开中...' : '安装到环境'}
                        </button>
                      </span>
                    ) : (
                      <button className="btn btn-secondary btn-xs" onClick={() => void installTo(p.id)} disabled={installing === p.id}>
                        {installing === p.id ? '打开中...' : '安装到环境'}
                      </button>
                    )}
                  </>
                ) : (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={bound.has(p.id)} onChange={() => void toggleBind(p.id)} className="accent-emerald-500" />
                    <span className="text-sm text-slate-200">{p.name}</span>
                  </label>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button className="btn btn-secondary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  )
}

function StoreInstallDialog({ onClose, onSubmit }: {
  onClose(): void
  onSubmit(url: string, name?: string): Promise<ExtensionRecord | null>
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await onSubmit(url, name || undefined)
    if (!r) setErr('添加失败，请检查链接')
    setBusy(false)
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-panel" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-white font-semibold mb-1">从 Chrome 应用商店添加</h3>
        <p className="text-xs text-slate-400 mb-4">粘贴商店链接或 32 位扩展 ID。添加后在「绑定环境」里点「安装到环境」，会在该环境内打开商店页原生安装。</p>
        <label className="block text-xs text-slate-400 mb-1">商店链接 / 扩展 ID</label>
        <input className="input mb-3" placeholder="https://chromewebstore.google.com/detail/.../abcdefg..." value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
        <label className="block text-xs text-slate-400 mb-1">名称（可选，留空自动识别）</label>
        <input className="input mb-3" placeholder="例如 uBlock Origin" value={name} onChange={(e) => setName(e.target.value)} />
        {err && <div className="rounded-lg bg-rose-500/15 border border-rose-500/30 px-3 py-2 text-xs text-rose-300 mb-3">{err}</div>}
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !url.trim()}>{busy ? '添加中...' : '添加'}</button>
        </div>
      </div>
    </div>
  )
}
