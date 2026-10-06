import { useEffect, useState } from 'react'
import { useApp, useSessions } from '../store'
import { formatBytes, formatTime, relativeTime } from '../lib/format'
import { STATUS_LABEL, STATUS_STYLE } from './ProfilesView'
import type { CookieFormat, ExportResult, SessionPolicy } from '@shared/session'

const POLICY_LABEL: Record<SessionPolicy, string> = {
  keep: '保留登录态',
  clear_cookies: '关闭时清 cookie',
  clear_all: '关闭时清空隔离目录'
}

const field = 'input'

export default function CookiesView(): React.JSX.Element {
  const { profiles, load: loadProfiles } = useApp()
  const {
    stats,
    loading,
    busy,
    error,
    notice,
    lastImport,
    load,
    refresh,
    exportBundle,
    importBundle,
    clear,
    cleanup,
    setPolicy,
    clearNotices
  } = useSessions()
  const [preview, setPreview] = useState<ExportResult | null>(null)
  const [panel, setPanel] = useState(false)
  const [target, setTarget] = useState('')
  const [text, setText] = useState('')
  const [format, setFormat] = useState<CookieFormat>('auto')
  const [includeStorage, setIncludeStorage] = useState(false)
  const [localNotice, setLocalNotice] = useState<string | null>(null)
  const message = notice ?? localNotice

  useEffect(() => {
    void load()
    void loadProfiles()
  }, [load, loadProfiles])

  useEffect(() => {
    if (!target && profiles.length) setTarget(profiles[0].id)
  }, [profiles, target])

  const statsMap = new Map(stats.map((x) => [x.profileId, x]))

  const doExport = async (id: string): Promise<void> => {
    const res = await exportBundle(id, includeStorage ? 'playwright' : 'netscape', includeStorage)
    if (res) setPreview(res)
  }

  const saveExport = async (): Promise<void> => {
    if (!preview) return
    const saved = await window.api.app.saveText(preview.filename, preview.content)
    if (saved) setLocalNotice(`已保存到 ${saved.path}`)
  }

  const pickFile = async (): Promise<void> => {
    const picked = await window.api.app.pickText()
    if (picked) {
      setText(picked.content)
      setLocalNotice(`已读取文件 ${picked.name}（${formatBytes(picked.content.length)}）`)
    }
  }

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <button
          onClick={() => setPanel((v) => !v)}
          className="btn btn-primary px-3 py-1.5 text-sm font-medium"
        >
          {panel ? '收起导入面板' : '+ 导入 Cookie / 会话'}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={includeStorage} onChange={(e) => setIncludeStorage(e.target.checked)} />
          导出时带上 localStorage
        </label>
        <button onClick={() => void load()} className="ml-auto  btn btn-secondary px-3 py-1.5 text-sm">
          刷新
        </button>
      </header>

      {message && (
        <div className="mx-5 mt-3 flex items-center gap-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-sm text-emerald-200">
          <span className="flex-1">{message}</span>
          <button onClick={() => { setLocalNotice(null); clearNotices() }} className="text-emerald-300/70 hover:text-emerald-100">
            关闭
          </button>
        </div>
      )}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-sm text-rose-200">{error}</div>
      )}

      {panel && (
        <div className="mx-5 mt-3 card p-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <select value={target} onChange={(e) => setTarget(e.target.value)} className={field}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  导入到：{p.name}
                </option>
              ))}
            </select>
            <select value={format} onChange={(e) => setFormat(e.target.value as CookieFormat)} className={field}>
              <option value="auto">自动识别格式</option>
              <option value="netscape">Netscape cookies.txt</option>
              <option value="playwright">Playwright storageState</option>
            </select>
            <button onClick={() => void pickFile()} className=" btn btn-secondary px-3 py-1.5 text-sm">
              从文件读取…
            </button>
            <button
              onClick={() => void importBundle(target, text, format)}
              disabled={!text.trim() || !target}
              className="btn btn-primary px-3 py-1.5 text-sm disabled:opacity-40"
            >
              导入登录态
            </button>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'粘贴 Netscape cookies.txt 或 Playwright storageState JSON；环境未运行时会自动临时拉起该环境读写'}
            className="mt-3 w-full h-40 rounded-md bg-slate-950/70 border border-slate-800 px-3 py-2 text-xs font-mono outline-none focus:border-emerald-500"
          />
          {lastImport && lastImport.issues.length > 0 && (
            <div className="mt-2 text-xs text-amber-300">
              跳过 {lastImport.issues.length} 行：{lastImport.issues.slice(0, 3).map((i) => i.reason).join('；')}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4">
        <table className="w-full border-collapse text-sm">
          <thead className="text-slate-400 text-xs sticky top-0 bg-[#0b0f14]">
            <tr className="text-left">
              <th className="py-2">环境</th>
              <th className="py-2">状态</th>
              <th className="py-2 text-right">Cookie</th>
              <th className="py-2 text-right">隔离目录体积</th>
              <th className="py-2">最后统计</th>
              <th className="py-2">关闭时策略</th>
              <th className="py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const st = statsMap.get(p.id)
              const isBusy = busy === p.id
              return (
                <tr key={p.id} className="border-t border-slate-800/70 hover:bg-slate-800/20">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-[11px] text-slate-500">上次打开 {relativeTime(p.lastOpenedAt)}</div>
                  </td>
                  <td className="py-2">
                    <span className={`rounded px-2 py-0.5 text-[11px] ${STATUS_STYLE[p.status] ?? STATUS_STYLE.stopped}`}>
                      {STATUS_LABEL[p.status] ?? p.status}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{st?.cookieCount ?? 0}</td>
                  <td className="py-2 text-right tabular-nums">{formatBytes(st?.sizeBytes ?? 0)}</td>
                  <td className="py-2 text-xs text-slate-400">{formatTime(st?.updatedAt)}</td>
                  <td className="py-2">
                    <select
                      value={st?.policy ?? 'keep'}
                      onChange={(e) => void setPolicy(p.id, e.target.value as SessionPolicy)}
                      className={field}
                    >
                      {(Object.keys(POLICY_LABEL) as SessionPolicy[]).map((k) => (
                        <option key={k} value={k}>
                          {POLICY_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2">
                    <div className="flex gap-1.5 justify-end flex-wrap">
                      <button onClick={() => void refresh(p.id)} disabled={isBusy} className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-40">
                        {isBusy ? '处理中…' : '读取'}
                      </button>
                      <button onClick={() => void doExport(p.id)} disabled={isBusy} className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-40">
                        导出
                      </button>
                      <button onClick={() => void cleanup(p.id, 'cache')} disabled={isBusy} className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-40">
                        清缓存
                      </button>
                      <button onClick={() => void clear(p.id)} disabled={isBusy} className="rounded bg-amber-600/80 hover:bg-amber-500 px-2 py-1 text-xs disabled:opacity-40">
                        清 cookie
                      </button>
                      <button
                        onClick={() => void cleanup(p.id, 'session')}
                        disabled={isBusy || p.status === 'running'}
                        title={p.status === 'running' ? '运行中的环境不能清空隔离目录' : ''}
                        className="rounded bg-rose-600/80 hover:bg-rose-500 px-2 py-1 text-xs disabled:opacity-40"
                      >
                        清空目录
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {!profiles.length && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-sm text-slate-500">
                  {loading ? '加载中…' : '还没有环境，先去「环境管理」新建一个'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="mt-4 text-xs text-slate-500 leading-relaxed">
          cookie 真身保存在各环境的隔离目录里（macOS 下加密）。环境未运行时点「读取 / 导出 / 导入」，
          会自动以 headless 临时拉起同一个环境，操作完立即关闭 —— 拿到的一定是内核实际使用的那份登录态。
        </p>
      </div>

      {preview && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6" onClick={() => setPreview(null)}>
          <div
            className="w-[720px] max-h-[80vh] overflow-auto rounded-lg border border-slate-700 bg-[#0d1117] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold">{preview.filename}</h3>
              <span className="text-xs text-slate-400">
                {preview.format} · {preview.cookieCount} 条 cookie · {preview.originCount} 个 origin / {preview.localStorageKeys} 项 localStorage
              </span>
              <button onClick={() => void saveExport()} className="ml-auto btn btn-primary px-3 py-1.5 text-sm">
                保存到文件…
              </button>
              <button onClick={() => setPreview(null)} className=" btn btn-secondary px-3 py-1.5 text-sm">
                关闭
              </button>
            </div>
            <textarea
              readOnly
              value={preview.content}
              className="mt-3 w-full h-[50vh] rounded-md bg-slate-950/70 border border-slate-800 px-3 py-2 text-xs font-mono"
            />
            <button
              onClick={() => void window.api.app.revealPath(preview.storagePath)}
              className="mt-2 text-xs text-slate-400 hover:text-slate-200"
            >
              打开快照所在目录
            </button>
          </div>
        </div>
      )}
    </>
  )
}