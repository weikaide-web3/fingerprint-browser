import { create } from 'zustand'
import type { Group, Profile, ProfileFilter, ProfileInput, ProxyInput, ProxyRecord, StatusEvent } from '@shared/types'
import type { DetectReport } from '@shared/detect'
import type { SettingView } from '@shared/settings'
import type { ApiStatus } from '@shared/api'
import type { AccountConflict, AccountInput, AccountRecord, AutofillPlan, TotpCodeView } from '@shared/account'
import type { AssociationReport } from '@shared/association'
import type { TlsBaseline, TlsObservation, TlsProbeResult } from '@shared/tls'
import type { KernelReportView } from '@shared/kernel'
import type { AppInfo } from '@shared/types'
import type { FlowRecord, FlowValidation, RpaFlow, RunSummary, StepLogEntry } from '@shared/rpa'
import type {
  CleanupResult,
  CleanupTarget,
  CookieFormat,
  ExportResult,
  ImportResult,
  KeyPreset,
  SessionPolicy,
  SessionRetention,
  SessionStats
} from '@shared/session'

interface AppState {
  profiles: Profile[]
  total: number
  groups: Group[]
  loading: boolean
  error: string | null
  filter: ProfileFilter
  page: number
  pageSize: number
  /** 非空表示环境管理页要切到「环境详情 / 编辑」子视图 */
  detailId: string | null
  openDetail(id: string): void
  closeDetail(): void
  setFilter(patch: Partial<ProfileFilter>): void
  setPage(page: number): void
  setPageSize(size: number): void
  load(): Promise<void>
  loadGroups(): Promise<void>
  create(input: ProfileInput): Promise<Profile | null>
  update(id: string, patch: Partial<ProfileInput>): Promise<void>
  remove(id: string): Promise<void>
  duplicate(id: string): Promise<void>
  regenerate(id: string): Promise<void>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
  applyStatus(evt: StatusEvent): void
}

export const useApp = create<AppState>((set, get) => ({
  profiles: [],
  total: 0,
  groups: [],
  loading: false,
  error: null,
  filter: { sort: 'created_at', order: 'asc' },
  page: 1,
  pageSize: 10,
  detailId: null,

  openDetail(id) {
    set({ detailId: id })
  },

  closeDetail() {
    set({ detailId: null })
  },

  setFilter(patch) {
    set({ filter: { ...get().filter, ...patch }, page: 1 })
    void get().load()
  },

  setPage(page) {
    set({ page })
    void get().load()
  },

  setPageSize(size) {
    set({ pageSize: size, page: 1 })
    void get().load()
  },

  async load() {
    set({ loading: true, error: null })
    try {
      const { filter, page, pageSize } = get()
      const res = await window.api.profiles.list({ ...filter, limit: pageSize, offset: (page - 1) * pageSize })
      set({ profiles: res.items, total: res.total, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async loadGroups() {
    try {
      set({ groups: await window.api.groups.list() })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async create(input) {
    try {
      const created = await window.api.profiles.create(input)
      await get().load()
      set({ error: null })
      return created
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  async update(id, patch) {
    try {
      await window.api.profiles.update(id, patch)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async remove(id) {
    try {
      await window.api.profiles.remove(id)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async duplicate(id) {
    const src = get().profiles.find((p) => p.id === id)
    if (!src) return
    try {
      await window.api.profiles.duplicate(id, `${src.name} 副本`)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async regenerate(id) {
    try {
      await window.api.profiles.regenerateFingerprint(id)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async start(id) {
    set({ error: null })
    try {
      await window.api.browser.start(id)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async stop(id) {
    try {
      await window.api.browser.stop(id)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async stopAll() {
    try {
      await window.api.browser.stopAll()
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  applyStatus(evt) {
    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === evt.profileId ? { ...p, status: evt.status } : p))
    }))
  }
}))

interface ProxyState {
  proxies: ProxyRecord[]
  usage: Record<string, number>
  loading: boolean
  error: string | null
  /** 正在检测的代理 id，用于逐行显示进度 */
  checking: string[]
  busy: boolean
  load(): Promise<void>
  create(input: ProxyInput & { password?: string | null }): Promise<ProxyRecord | null>
  update(id: string, patch: Partial<ProxyInput> & { password?: string | null }): Promise<boolean>
  remove(id: string): Promise<boolean>
  check(id: string): Promise<boolean>
  checkAll(ids?: string[]): Promise<void>
  importText(text: string): Promise<{ imported: number; skipped: { line: string; reason: string }[] } | null>
}

export const useProxies = create<ProxyState>((set, get) => ({
  proxies: [],
  usage: {},
  loading: false,
  error: null,
  checking: [],
  busy: false,

  async load() {
    set({ loading: true, error: null })
    try {
      const [proxies, usage] = await Promise.all([window.api.proxies.list(), window.api.proxies.usage()])
      set({ proxies, usage, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async create(input) {
    set({ error: null })
    try {
      const created = await window.api.proxies.create(input)
      await get().load()
      return created
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  async update(id, patch) {
    set({ error: null })
    try {
      await window.api.proxies.update(id, patch)
      await get().load()
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  async remove(id) {
    set({ error: null })
    try {
      await window.api.proxies.remove(id)
      await get().load()
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  async check(id) {
    set((s) => ({ checking: [...s.checking, id], error: null }))
    try {
      const res = await window.api.proxies.check(id)
      await get().load()
      if (!res.ok) set({ error: res.error ?? '检测失败' })
      return res.ok
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    } finally {
      set((s) => ({ checking: s.checking.filter((x) => x !== id) }))
    }
  },

  async checkAll(ids) {
    set({ busy: true, error: null })
    try {
      const target = ids?.length ? ids : get().proxies.map((p) => p.id)
      set((s) => ({ checking: [...s.checking, ...target] }))
      const res = await window.api.proxies.checkAll(target)
      await get().load()
      if (res.failed.length) {
        set({ error: `${res.ok} 个通过，${res.failed.length} 个失败（${res.failed[0].error}）` })
      }
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false, checking: [] })
    }
  },

  async importText(text) {
    set({ error: null })
    try {
      const res = await window.api.proxies.import(text)
      await get().load()
      return res
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  }
}))

interface SessionState {
  stats: SessionStats[]
  presets: KeyPreset[]
  loading: boolean
  busy: string | null
  error: string | null
  notice: string | null
  lastExport: ExportResult | null
  lastImport: ImportResult | null
  load(): Promise<void>
  refresh(id: string): Promise<void>
  exportBundle(id: string, format: Exclude<CookieFormat, 'auto'>, includeStorage: boolean): Promise<ExportResult | null>
  importBundle(id: string, content: string, format: CookieFormat): Promise<ImportResult | null>
  clear(id: string, ignoreProtection?: boolean): Promise<void>
  cleanup(id: string, target: CleanupTarget): Promise<CleanupResult | null>
  setPolicy(id: string, policy: SessionPolicy): Promise<void>
  setRetention(id: string, retention: Partial<SessionRetention>): Promise<void>
  clearNotices(): void
}

export const useSessions = create<SessionState>((set, get) => ({
  stats: [],
  presets: [],
  loading: false,
  busy: null,
  error: null,
  notice: null,
  lastExport: null,
  lastImport: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const [stats, presets] = await Promise.all([window.api.session.statsAll(), window.api.session.keyPresets()])
      set({ stats, presets, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async refresh(id) {
    set({ busy: id, error: null })
    try {
      const stats = await window.api.session.refresh(id)
      set((s) => ({ stats: s.stats.map((x) => (x.profileId === id ? stats : x)), busy: null, notice: `已读取登录态：${stats.cookieCount} 条 cookie` }))
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
    }
  },

  async exportBundle(id, format, includeStorage) {
    set({ busy: id, error: null })
    try {
      const res = await window.api.session.export(id, { format, includeStorage })
      set({ lastExport: res, busy: null, notice: `已导出 ${res.cookieCount} 条 cookie（${res.format}）` })
      await get().load()
      return res
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
      return null
    }
  },

  async importBundle(id, content, format) {
    set({ busy: id, error: null })
    try {
      const res = await window.api.session.import(id, content, format)
      set({
        lastImport: res,
        busy: null,
        notice: `已导入 ${res.added} 条 cookie，当前共 ${res.total} 条${res.issues.length ? `（跳过 ${res.issues.length} 行）` : ''}`
      })
      await get().load()
      return res
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
      return null
    }
  },

  async clear(id, ignoreProtection) {
    set({ busy: id, error: null })
    try {
      const res = await window.api.session.clear(id, ignoreProtection)
      set({
        notice:
          `已清理 ${res.cleared} 条 cookie` +
          (res.kept ? `，保留 ${res.kept} 条关键键（${res.keptKeys.slice(0, 4).join(', ')}）` : ''),
        busy: null
      })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
    }
  },

  async cleanup(id, target) {
    set({ busy: id, error: null })
    try {
      const res = await window.api.session.cleanup(id, target)
      set({ notice: `已清理 ${res.removed.length} 项，释放 ${(res.freedBytes / 1024 / 1024).toFixed(1)} MB`, busy: null })
      await get().load()
      return res
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
      return null
    }
  },

  async setPolicy(id, policy) {
    set({ error: null })
    try {
      const stats = await window.api.session.setPolicy(id, policy)
      set((s) => ({ stats: s.stats.map((x) => (x.profileId === id ? stats : x)) }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async setRetention(id, retention) {
    set({ error: null })
    try {
      const stats = await window.api.session.setRetention(id, retention)
      set((s) => ({
        stats: s.stats.map((x) => (x.profileId === id ? stats : x)),
        notice: `已更新「${stats.name}」的登录态保留策略`
      }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  clearNotices() {
    set({ notice: null, error: null })
  }
}))

interface DetectState {
  profileId: string
  running: boolean
  report: DetectReport | null
  error: string | null
  onlyIssues: boolean
  select(id: string): void
  toggleOnlyIssues(): void
  run(id?: string, samples?: number): Promise<void>
  reset(): void
}

export const useDetect = create<DetectState>((set, get) => ({
  profileId: '',
  running: false,
  report: null,
  error: null,
  onlyIssues: false,

  select(id) {
    set({ profileId: id })
  },
  toggleOnlyIssues() {
    set((s) => ({ onlyIssues: !s.onlyIssues }))
  },
  async run(id, samples) {
    const target = id || get().profileId
    if (!target) {
      set({ error: '请先选择一个环境' })
      return
    }
    set({ running: true, error: null, profileId: target })
    try {
      set({ report: await window.api.detect.run(target, samples), running: false })
    } catch (e) {
      set({ error: (e as Error).message, running: false })
    }
  },
  reset() {
    set({ report: null, error: null })
  }
}))

interface SettingsState {
  items: SettingView[]
  info: AppInfo | null
  loading: boolean
  busy: string | null
  error: string | null
  notice: string | null
  load(): Promise<void>
  set(key: string, value: string | number | boolean | null): Promise<boolean>
  reset(key: string): Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  items: [],
  info: null,
  loading: false,
  busy: null,
  error: null,
  notice: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const [items, info] = await Promise.all([window.api.settings.view(), window.api.app.getInfo()])
      set({ items, info, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async set(key, value) {
    set({ busy: key, error: null, notice: null })
    try {
      const items = await window.api.settings.set(key, value)
      const def = items.find((i) => i.key === key)
      set({
        items,
        busy: null,
        notice: `${def?.label ?? key} 已保存${def?.restart === 'app' ? '（重启应用后生效）' : def?.restart === 'profile' ? '（下次打开环境生效）' : ''}`
      })
      return true
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
      await get().load()
      return false
    }
  },

  async reset(key) {
    set({ busy: key, error: null })
    try {
      set({ items: await window.api.settings.reset(key), busy: null, notice: '已恢复默认值' })
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
    }
  }
}))

export interface RpaStepEvent extends StepLogEntry {
  runId: string
}

interface RpaState {
  flows: FlowRecord[]
  runs: RunSummary[]
  flowId: string
  profileId: string
  saving: boolean
  running: boolean
  currentRunId: string
  events: RpaStepEvent[]
  validation: FlowValidation | null
  error: string | null
  notice: string | null
  load(): Promise<void>
  select(flowId: string, profileId?: string): void
  create(flow: RpaFlow): Promise<FlowRecord | null>
  update(id: string, flow: RpaFlow): Promise<boolean>
  remove(id: string): Promise<void>
  validate(flow: RpaFlow): Promise<void>
  sample(): Promise<RpaFlow | null>
  run(flowId?: string, profileId?: string, params?: Record<string, string>): Promise<void>
  stop(): Promise<void>
  pushEvent(e: RpaStepEvent): void
  clearEvents(): void
}

export const useRpa = create<RpaState>((set, get) => ({
  flows: [],
  runs: [],
  flowId: '',
  profileId: '',
  saving: false,
  running: false,
  currentRunId: '',
  events: [],
  validation: null,
  error: null,
  notice: null,

  async load() {
    try {
      const [flows, runs] = await Promise.all([window.api.rpa.list(), window.api.rpa.runs(30)])
      set({ flows, runs })
      if (!get().flowId && flows.length) set({ flowId: flows[0].id })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  select(flowId, profileId) {
    set({ flowId, ...(profileId ? { profileId } : {}) })
  },

  async create(flow) {
    set({ saving: true, error: null })
    try {
      const rec = await window.api.rpa.create(flow)
      set({ saving: false, flowId: rec.id, notice: `已创建流程「${rec.name}」` })
      await get().load()
      return rec
    } catch (e) {
      set({ error: (e as Error).message, saving: false })
      return null
    }
  },

  async update(id, flow) {
    set({ saving: true, error: null })
    try {
      await window.api.rpa.update(id, flow)
      set({ saving: false, notice: '流程已保存' })
      await get().load()
      return true
    } catch (e) {
      set({ error: (e as Error).message, saving: false })
      return false
    }
  },

  async remove(id) {
    try {
      await window.api.rpa.remove(id)
      if (get().flowId === id) set({ flowId: '' })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async validate(flow) {
    try {
      set({ validation: await window.api.rpa.validate(flow) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async sample() {
    try {
      return await window.api.rpa.sample()
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  async run(flowId, profileId, params) {
    const fid = flowId || get().flowId
    const pid = profileId || get().profileId
    if (!fid || !pid) {
      set({ error: '请先选择流程与环境' })
      return
    }
    set({ running: true, error: null, events: [], flowId: fid, profileId: pid })
    try {
      const run = await window.api.rpa.run(fid, pid, params)
      set({ running: false, currentRunId: run.id })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message, running: false })
    }
  },

  async stop() {
    const runId = get().currentRunId
    if (!runId) return
    try {
      await window.api.rpa.stop(runId)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  pushEvent(e) {
    set((s) => ({ events: [...s.events, e] }))
  },
  clearEvents() {
    set({ events: [] })
  }
}))

interface ApiState {
  status: ApiStatus | null
  loading: boolean
  busy: boolean
  error: string | null
  notice: string | null
  load(): Promise<void>
  act(action: 'start' | 'stop' | 'restart' | 'generateToken', msg: string): Promise<void>
}

export const useApi = create<ApiState>((set) => ({
  status: null,
  loading: false,
  busy: false,
  error: null,
  notice: null,

  async load() {
    set({ loading: true, error: null })
    try {
      set({ status: await window.api.api.status(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async act(action, msg) {
    set({ busy: true, error: null, notice: null })
    try {
      const status = await window.api.api[action]()
      set({ status, busy: false, notice: msg })
    } catch (e) {
      set({ error: (e as Error).message, busy: false })
      set({ status: await window.api.api.status().catch(() => null) })
    }
  }
}))

interface AccountsState {
  items: AccountRecord[]
  counts: Record<string, number>
  conflicts: AccountConflict[]
  loading: boolean
  busy: string | null
  error: string | null
  notice: string | null
  code: TotpCodeView | null
  plan: AutofillPlan | null
  load(): Promise<void>
  create(input: AccountInput): Promise<boolean>
  update(id: string, patch: Partial<AccountInput>): Promise<boolean>
  remove(id: string): Promise<void>
  showCode(id: string): Promise<void>
  showPlan(id: string, includeTotp?: boolean): Promise<void>
  clearNotices(): void
}

export const useAccounts = create<AccountsState>((set, get) => ({
  items: [],
  counts: {},
  conflicts: [],
  loading: false,
  busy: null,
  error: null,
  notice: null,
  code: null,
  plan: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const [items, counts, conflicts] = await Promise.all([
        window.api.account.list(),
        window.api.account.counts(),
        window.api.account.conflicts()
      ])
      set({ items, counts, conflicts, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async create(input) {
    set({ busy: 'create', error: null, notice: null })
    try {
      await window.api.account.create(input)
      set({ busy: null, notice: `已添加账号 ${input.username}` })
      await get().load()
      return true
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
      return false
    }
  },

  async update(id, patch) {
    set({ busy: id, error: null, notice: null })
    try {
      await window.api.account.update(id, patch)
      set({ busy: null, notice: '已保存' })
      await get().load()
      return true
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
      return false
    }
  },

  async remove(id) {
    set({ busy: id, error: null })
    try {
      await window.api.account.remove(id)
      set({ busy: null, notice: '已删除', code: null, plan: null })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
    }
  },

  async showCode(id) {
    set({ busy: id, error: null, code: null })
    try {
      set({ code: await window.api.account.totpCode(id), busy: null })
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
    }
  },

  async showPlan(id, includeTotp) {
    set({ busy: id, error: null, plan: null })
    try {
      set({ plan: await window.api.account.plan(id, includeTotp), busy: null })
    } catch (e) {
      set({ error: (e as Error).message, busy: null })
    }
  },

  clearNotices() {
    set({ notice: null, error: null, code: null, plan: null })
  }
}))

interface AssociationState {
  report: AssociationReport | null
  loading: boolean
  error: string | null
  level: 'all' | 'issue'
  load(): Promise<void>
  setLevel(level: 'all' | 'issue'): void
}

export const useAssociation = create<AssociationState>((set) => ({
  report: null,
  loading: false,
  error: null,
  level: 'issue',

  async load() {
    set({ loading: true, error: null })
    try {
      set({ report: await window.api.association.check(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },
  setLevel(level) {
    set({ level })
  }
}))

interface TlsState {
  profileId: string
  running: boolean
  report: TlsProbeResult | null
  baselines: TlsBaseline[]
  history: TlsObservation[]
  error: string | null
  notice: string | null
  select(id: string): void
  load(): Promise<void>
  probe(id?: string): Promise<void>
  promote(): Promise<void>
}

export const useTls = create<TlsState>((set, get) => ({
  profileId: '',
  running: false,
  report: null,
  baselines: [],
  history: [],
  error: null,
  notice: null,

  select(id) {
    set({ profileId: id })
  },

  async load() {
    try {
      const [baselines] = await Promise.all([window.api.tls.baselines()])
      set({ baselines })
      const pid = get().profileId
      if (pid) set({ history: await window.api.tls.history(pid, 20) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async probe(id) {
    const target = id || get().profileId
    if (!target) {
      set({ error: '请先选择一个环境' })
      return
    }
    set({ running: true, error: null, notice: null, profileId: target })
    try {
      const report = await window.api.tls.probe(target)
      set({ report, running: false, error: report.error, notice: report.error ? null : '观测完成' })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message, running: false })
    }
  },

  async promote() {
    const pid = get().profileId
    if (!pid) return
    set({ error: null, notice: null })
    try {
      const b = await window.api.tls.promoteBaseline(pid)
      set({ notice: `已把 ${b.kernelVersion} 的观测设为基线（样本 ${b.samples}）` })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))

interface KernelState {
  report: KernelReportView | null
  loading: boolean
  busy: boolean
  error: string | null
  notice: string | null
  load(): Promise<void>
  useBranded(): Promise<void>
  clearOverride(): Promise<void>
  setPreferBranded(on: boolean): Promise<void>
}

export const useKernel = create<KernelState>((set) => ({
  report: null,
  loading: false,
  busy: false,
  error: null,
  notice: null,

  async load() {
    set({ loading: true, error: null })
    try {
      set({ report: await window.api.kernel.report(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async useBranded() {
    set({ busy: true, error: null, notice: null })
    try {
      const report = await window.api.kernel.useBranded()
      set({
        report,
        busy: false,
        notice: `已切换到正式版 Chrome：${report.identity.path}（重新打开环境后生效）`
      })
    } catch (e) {
      set({ error: (e as Error).message, busy: false })
    }
  },

  async clearOverride() {
    set({ busy: true, error: null, notice: null })
    try {
      set({ report: await window.api.kernel.clearOverride(), busy: false, notice: '已恢复自动解析内核' })
    } catch (e) {
      set({ error: (e as Error).message, busy: false })
    }
  },

  async setPreferBranded(on) {
    set({ busy: true, error: null })
    try {
      set({ report: await window.api.kernel.setPreferBranded(on), busy: false })
    } catch (e) {
      set({ error: (e as Error).message, busy: false })
    }
  }
}))

// --- Extensions ---

import type { ExtensionRecord } from '@shared/types'

interface ExtensionState {
  extensions: ExtensionRecord[]
  usage: Record<string, number>
  loading: boolean
  error: string | null
  busy: boolean
  load(): Promise<void>
  install(dirPath: string): Promise<ExtensionRecord | null>
  installStore(urlOrId: string, name?: string): Promise<ExtensionRecord | null>
  installInProfile(extensionId: string, profileId: string): Promise<{ opened: number; url: string } | null>
  uninstall(id: string): Promise<boolean>
  toggle(id: string, enabled: boolean): Promise<void>
  bind(extensionId: string, profileId: string): Promise<void>
  unbind(extensionId: string, profileId: string): Promise<void>
}

export const useExtensions = create<ExtensionState>((set, get) => ({
  extensions: [],
  usage: {},
  loading: false,
  error: null,
  busy: false,

  async load() {
    set({ loading: true, error: null })
    try {
      const [extensions, usage] = await Promise.all([window.api.extensions.list(), window.api.extensions.usage()])
      set({ extensions, usage, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  async install(dirPath) {
    set({ busy: true, error: null })
    try {
      const created = await window.api.extensions.install(dirPath)
      await get().load()
      return created
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    } finally {
      set({ busy: false })
    }
  },

  async installStore(urlOrId, name) {
    set({ busy: true, error: null })
    try {
      const created = await window.api.extensions.installStore(urlOrId, name)
      await get().load()
      return created
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    } finally {
      set({ busy: false })
    }
  },

  async installInProfile(extensionId, profileId) {
    set({ error: null })
    try {
      return await window.api.extensions.installInProfile(extensionId, profileId)
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    } finally {
      await get().load()
    }
  },

  async uninstall(id) {
    set({ error: null })
    try {
      await window.api.extensions.uninstall(id)
      await get().load()
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  async toggle(id, enabled) {
    try {
      await window.api.extensions.toggle(id, enabled)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async bind(extensionId, profileId) {
    try {
      await window.api.extensions.bind(extensionId, profileId)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async unbind(extensionId, profileId) {
    try {
      await window.api.extensions.unbind(extensionId, profileId)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))

// --- Scheduler (定时调度) ---
import type {
  BackupInfo,
  HealthSummary,
  HistoryEntry,
  MonitorAlerts,
  PortImportResult,
  ProfileBundle,
  ResourceReport,
  ScheduleRecord
} from '@shared/ops'

interface SchedulerState {
  schedules: ScheduleRecord[]
  loading: boolean
  error: string | null
  load(): Promise<void>
  create(input: { flowId: string; cron: string; profileId: string; params?: Record<string, string>; enabled?: boolean }): Promise<ScheduleRecord | null>
  update(id: string, patch: { cron?: string; enabled?: boolean; params?: Record<string, string>; profileId?: string }): Promise<void>
  remove(id: string): Promise<void>
  toggle(id: string, enabled: boolean): Promise<void>
  runNow(id: string): Promise<void>
}

export const useScheduler = create<SchedulerState>((set, get) => ({
  schedules: [],
  loading: false,
  error: null,
  async load() {
    set({ loading: true, error: null })
    try {
      set({ schedules: await window.api.scheduler.list(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },
  async create(input) {
    set({ error: null })
    try {
      const created = await window.api.scheduler.create(input)
      await get().load()
      return created
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },
  async update(id, patch) {
    try {
      await window.api.scheduler.update(id, patch)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async remove(id) {
    try {
      await window.api.scheduler.remove(id)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async toggle(id, enabled) {
    try {
      await window.api.scheduler.toggle(id, enabled)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async runNow(id) {
    try {
      await window.api.scheduler.runNow(id)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))

// --- Backup (备份/恢复) ---
interface BackupState {
  backups: BackupInfo[]
  loading: boolean
  busy: boolean
  error: string | null
  load(): Promise<void>
  create(label?: string): Promise<void>
  restore(id: string): Promise<boolean>
  remove(id: string): Promise<void>
  reveal(): Promise<void>
}

export const useBackup = create<BackupState>((set, get) => ({
  backups: [],
  loading: false,
  busy: false,
  error: null,
  async load() {
    set({ loading: true, error: null })
    try {
      set({ backups: await window.api.backup.list(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },
  async create(label) {
    set({ busy: true, error: null })
    try {
      await window.api.backup.create(label)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  },
  async restore(id) {
    set({ busy: true, error: null })
    try {
      await window.api.backup.restore(id)
      await get().load()
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    } finally {
      set({ busy: false })
    }
  },
  async remove(id) {
    try {
      await window.api.backup.remove(id)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async reveal() {
    try {
      await window.api.backup.reveal()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))

// --- Health (健康度) ---
interface HealthState {
  summary: HealthSummary | null
  loading: boolean
  error: string | null
  load(): Promise<void>
}

export const useHealth = create<HealthState>((set) => ({
  summary: null,
  loading: false,
  error: null,
  async load() {
    set({ loading: true, error: null })
    try {
      set({ summary: await window.api.health.summary(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  }
}))

// --- Resources (资源监控) ---
interface ResourceState {
  report: ResourceReport | null
  loading: boolean
  error: string | null
  load(): Promise<void>
}

export const useResources = create<ResourceState>((set) => ({
  report: null,
  loading: false,
  error: null,
  async load() {
    set({ loading: true, error: null })
    try {
      set({ report: await window.api.resources.report(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  }
}))

// --- History (操作历史) ---
interface HistoryState {
  entries: HistoryEntry[]
  loading: boolean
  error: string | null
  load(opts?: { limit?: number; profileId?: string }): Promise<void>
}

export const useHistory = create<HistoryState>((set) => ({
  entries: [],
  loading: false,
  error: null,
  async load(opts) {
    set({ loading: true, error: null })
    try {
      set({ entries: await window.api.history.list(opts), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  }
}))

// --- Monitor (后台监控告警) ---
interface MonitorState {
  alerts: MonitorAlerts | null
  loading: boolean
  error: string | null
  load(): Promise<void>
  runProxy(): Promise<void>
  runCookie(): Promise<void>
  runDrift(): Promise<void>
}

export const useMonitor = create<MonitorState>((set) => ({
  alerts: null,
  loading: false,
  error: null,
  async load() {
    set({ loading: true, error: null })
    try {
      set({ alerts: await window.api.monitor.alerts(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },
  async runProxy() {
    set({ loading: true })
    try {
      set({ alerts: await window.api.monitor.runProxyCheck(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },
  async runCookie() {
    try {
      set({ alerts: await window.api.monitor.runCookieCheck() })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async runDrift() {
    set({ loading: true })
    try {
      set({ alerts: await window.api.monitor.runDriftCheck(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  }
}))

// --- Port (环境导入/导出) ---
export async function exportProfileBundle(profileId: string): Promise<ProfileBundle> {
  return window.api.port.export(profileId)
}

export async function importProfileBundle(bundle: ProfileBundle, name?: string): Promise<PortImportResult> {
  const r = await window.api.port.import(bundle, name ? { name } : undefined)
  await useApp.getState().load()
  return r
}

// --- Trash (回收站) ---
import type { TrashItem, TrashKind } from '@shared/ops'
import type { WebAuthnCredentialView, WebAuthnStatus } from '@shared/webauthn'

interface TrashState {
  items: TrashItem[]
  loading: boolean
  error: string | null
  load(): Promise<void>
  restore(kind: TrashKind, id: string): Promise<void>
  purge(kind: TrashKind, id: string): Promise<void>
  empty(): Promise<void>
}

export const useTrash = create<TrashState>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  async load() {
    set({ loading: true, error: null })
    try {
      set({ items: await window.api.trash.list(), loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },
  async restore(kind, id) {
    set({ error: null })
    try {
      await window.api.trash.restore(kind, id)
      await get().load()
      await useApp.getState().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async purge(kind, id) {
    set({ error: null })
    try {
      await window.api.trash.purge(kind, id)
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async empty() {
    set({ error: null })
    try {
      await window.api.trash.empty()
      await get().load()
      await useApp.getState().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))

interface WebAuthnState {
  profileId: string
  status: WebAuthnStatus | null
  credentials: WebAuthnCredentialView[]
  issues: string[]
  busy: boolean
  error: string | null
  notice: string | null
  select(id: string): void
  load(): Promise<void>
  enroll(input: { rpId: string; rpName?: string; userName?: string; origin?: string }): Promise<void>
  verify(credentialId: string, origin?: string): Promise<void>
  remove(id: string): Promise<void>
}

/**
 * Passkey / WebAuthn 页状态。
 *
 * 服务层与集成测试早就有了，但一直没有界面入口 —— 用户没法注册 passkey，
 * 而 Google / X 现在对新设备优先推 passkey，没有可注册的认证器就会被
 * 降级到手机/邮箱验证，那本身就是风控信号。
 */
export const useWebAuthn = create<WebAuthnState>((set, get) => ({
  profileId: '',
  status: null,
  credentials: [],
  issues: [],
  busy: false,
  error: null,
  notice: null,

  select(id) {
    set({ profileId: id })
  },

  async load() {
    const id = get().profileId
    if (!id) return
    set({ error: null })
    try {
      const [status, credentials, issues] = await Promise.all([
        window.api.webauthn.status(id),
        window.api.webauthn.list(id),
        window.api.webauthn.issues(id)
      ])
      set({ status, credentials, issues })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async enroll(input) {
    const id = get().profileId
    if (!id) return
    set({ busy: true, error: null, notice: null })
    try {
      const r = await window.api.webauthn.enroll(id, input)
      set({ busy: false, notice: r.message })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message, busy: false })
    }
  },

  async verify(credentialId, origin) {
    const id = get().profileId
    if (!id) return
    set({ busy: true, error: null, notice: null })
    try {
      const r = await window.api.webauthn.verify(id, credentialId, origin)
      set({ busy: false, notice: r.message, error: r.ok ? null : r.message })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message, busy: false })
    }
  },

  async remove(credId) {
    set({ error: null, notice: null })
    try {
      await window.api.webauthn.remove(credId)
      set({ notice: '已删除该 passkey 记录' })
      await get().load()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))
