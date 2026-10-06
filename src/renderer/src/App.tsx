import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useProxies, useExtensions, useScheduler, useBackup, useHealth, useResources, useHistory, useMonitor } from './store'
import ProfilesView from './components/ProfilesView'
import ProfileDetailView from './components/ProfileDetailView'
import ProxiesView from './components/ProxiesView'
import CookiesView from './components/CookiesView'
import DetectView from './components/DetectView'
import SettingsView from './components/SettingsView'
import ApiView from './components/ApiView'
import RpaView from './components/RpaView'
import AccountsView from './components/AccountsView'
import AssociationView from './components/AssociationView'
import TlsView from './components/TlsView'
import KernelView from './components/KernelView'
import ExtensionsView from './components/ExtensionsView'
import WebAuthnView from './components/WebAuthnView'
import TrashView from './components/TrashView'
import SchedulerView from './components/SchedulerView'
import BackupView from './components/BackupView'
import HealthView from './components/HealthView'
import ResourcesView from './components/ResourcesView'
import HistoryView from './components/HistoryView'
import MonitorView from './components/MonitorView'
import ErrorBoundary from './components/ErrorBoundary'
import type { AppInfo } from '@shared/types'

type NavKey =
  | 'profiles' | 'proxies' | 'cookies' | 'detect' | 'tls' | 'kernel'
  | 'extensions' | 'webauthn' | 'accounts' | 'association' | 'health' | 'monitor'
  | 'scheduler' | 'rpa' | 'resources' | 'history' | 'backup' | 'trash' | 'api' | 'settings'

const NAV_ITEMS: { key: NavKey; label: string; icon: string }[] = [
  { key: 'profiles', label: '环境管理', icon: '🌐' },
  { key: 'proxies', label: '代理管理', icon: '🔀' },
  { key: 'cookies', label: 'Cookie / 会话', icon: '🍪' },
  { key: 'detect', label: '指纹检测', icon: '🔍' },
  { key: 'tls', label: 'TLS / HTTP2', icon: '🔒' },
  { key: 'kernel', label: '内核能力', icon: '⚙️' },
  { key: 'extensions', label: '扩展管理', icon: '🧩' },
  { key: 'webauthn', label: 'Passkey', icon: '🔐' },
  { key: 'accounts', label: '账号保管', icon: '🔑' },
  { key: 'association', label: '关联隔离', icon: '🛡️' },
  { key: 'health', label: '环境健康', icon: '🩺' },
  { key: 'monitor', label: '监控告警', icon: '📊' },
  { key: 'scheduler', label: '定时调度', icon: '⏰' },
  { key: 'rpa', label: 'RPA', icon: '🤖' },
  { key: 'resources', label: '资源监控', icon: '📈' },
  { key: 'history', label: '操作历史', icon: '📜' },
  { key: 'backup', label: '备份恢复', icon: '💾' },
  { key: 'trash', label: '回收站', icon: '🗑️' },
  { key: 'api', label: '自动化 API', icon: '📡' },
  { key: 'settings', label: '设置', icon: '🎛️' }
]

const VIEW_MAP: Record<NavKey, () => React.JSX.Element> = {
  proxies: ProxiesView, cookies: CookiesView, detect: DetectView, tls: TlsView,
  kernel: KernelView, extensions: ExtensionsView, webauthn: WebAuthnView, accounts: AccountsView,
  association: AssociationView, health: HealthView, monitor: MonitorView,
  scheduler: SchedulerView, rpa: RpaView, resources: ResourcesView,
  history: HistoryView, backup: BackupView, api: ApiView, settings: SettingsView,
  trash: TrashView,
  profiles: ProfilesView
}

export default function App(): React.JSX.Element {
  const { profiles, total, load, loadGroups, detailId, closeDetail, stop } = useApp()
  const [nav, setNav] = useState<NavKey>('profiles')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [security, setSecurity] = useState<AppInfo['encryption'] | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void load()
    void loadGroups()
    // 加密状态是全局安全问题（钥匙串不可用时凭据明文落库），必须在任何页面都能看到
    void window.api.app
      .getInfo()
      .then((i) => setSecurity(i.encryption))
      .catch(() => setSecurity(null))
    const offStatus = window.api.events.onStatus((evt) => useApp.getState().applyStatus(evt))
    // 备份恢复等整库替换后，主进程广播 reload：重新拉取所有 store
    const offReload = window.api.events.onReload(() => {
      void useApp.getState().load()
      void useApp.getState().loadGroups()
      void useProxies.getState().load()
      void useExtensions.getState().load()
      void useScheduler.getState().load()
      void useBackup.getState().load()
      void useHealth.getState().load()
      void useResources.getState().load()
      void useHistory.getState().load()
      void useMonitor.getState().load()
    })
    return () => {
      offStatus()
      offReload()
    }
  }, [load, loadGroups])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'f') {
        e.preventDefault(); setSearchOpen(true)
      } else if (meta && e.shiftKey && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        for (const p of useApp.getState().profiles) if (p.status === 'running') void stop(p.id)
      } else if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault(); closeDetail(); setNav('profiles')
        window.dispatchEvent(new CustomEvent('fpb:new-profile'))
      } else if (e.key === 'Escape') {
        setSearchOpen(false); setQuery('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeDetail, stop])

  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])

  const runningCount = useMemo(() => profiles.filter((p) => p.status === 'running').length, [profiles])
  const searchResults = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return profiles.filter((p) => p.name.toLowerCase().includes(q) || (p.note ?? '').toLowerCase().includes(q)).slice(0, 8)
  }, [query, profiles])

  const View = VIEW_MAP[nav]

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 flex flex-col bg-[#0d1117] border-r border-[#1e293b]">
        <div className="px-4 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center text-white text-sm font-bold shadow-lg shadow-emerald-500/20">F</div>
            <div>
              <div className="text-[13px] font-semibold text-slate-100 leading-tight">指纹浏览器</div>
              <div className="text-[10px] text-slate-500">Anti-Detect Browser</div>
            </div>
          </div>
        </div>
        <div className="px-3 pb-2">
          <button type="button" onClick={() => setSearchOpen(true)} className="w-full flex items-center gap-2 rounded-lg bg-slate-800/50 border border-[#1e293b] px-3 py-1.5 text-xs text-slate-500 hover:border-slate-600 transition-colors">
            <span>🔎</span><span>搜索环境…</span><kbd className="ml-auto text-[10px] text-slate-600">⌘F</kbd>
          </button>
        </div>
        <nav className="flex-1 px-2.5 py-2 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const active = nav === item.key
            return (
              <button key={item.key} type="button" onClick={() => { closeDetail(); setNav(item.key) }} aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-all duration-150 ${active ? 'bg-emerald-500/10 text-emerald-300 font-medium shadow-sm' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}>
                <span className="text-base leading-none w-5 text-center">{item.icon}</span>
                <span>{item.label}</span>
                {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />}
              </button>
            )
          })}
        </nav>
        <div className="px-4 py-3 border-t border-[#1e293b]">
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${runningCount > 0 ? 'bg-emerald-400 animate-pulse-dot' : 'bg-slate-600'}`} />
              运行中 {runningCount}
            </span>
            <span>共 {total} 个环境</span>
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0 bg-[#0b0f14]">
        {security?.message && (
          <div className="px-5 py-2.5 text-xs bg-amber-500/10 border-b border-amber-500/25 text-amber-200 flex items-center gap-2">
            <span>🔒</span>
            <span>{security.message}</span>
          </div>
        )}
        <ErrorBoundary key={nav} label={NAV_ITEMS.find((n) => n.key === nav)?.label}>
          {nav === 'profiles' && detailId ? <ProfileDetailView profileId={detailId} /> : <View />}
        </ErrorBoundary>
      </main>
      {searchOpen && <SearchOverlay query={query} setQuery={setQuery} results={searchResults} searchRef={searchRef} onPick={(id) => { closeDetail(); setNav('profiles'); useApp.getState().openDetail(id); setSearchOpen(false); setQuery('') }} onClose={() => setSearchOpen(false)} />}
    </div>
  )
}

function SearchOverlay({ query, setQuery, results, searchRef, onPick, onClose }: {
  query: string
  setQuery(v: string): void
  results: { id: string; name: string; status: string; proxy?: { scheme: string; host: string } | null }[]
  searchRef: React.RefObject<HTMLInputElement | null>
  onPick(id: string): void
  onClose(): void
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[520px] bg-[#0d1117] border border-[#1e293b] rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <input ref={searchRef} className="w-full bg-transparent px-4 py-3 text-sm text-white outline-none border-b border-[#1e293b]" placeholder="搜索环境名称 / 备注…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="max-h-[320px] overflow-auto py-2">
          {query.trim() === '' ? (
            <div className="px-4 py-6 text-center text-xs text-slate-500">输入关键词搜索环境</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-slate-500">未找到匹配的环境</div>
          ) : (
            results.map((p) => (
              <button key={p.id} type="button" className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-800/50 transition-colors" onClick={() => onPick(p.id)}>
                <span className={`w-2 h-2 rounded-full ${p.status === 'running' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="text-sm text-slate-200">{p.name}</span>
                {p.proxy && <span className="ml-auto text-[11px] text-slate-500">{p.proxy.scheme}://{p.proxy.host}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

