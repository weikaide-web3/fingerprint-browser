import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  AppInfo,
  BrowserLaunchResult,
  ConsistencyReport,
  DetectReport,
  ExtensionRecord,
  FingerprintConfig,
  Group,
  ListResult,
  LogEvent,
  Profile,
  ProfileFilter,
  ProfileInput,
  ProxyInput,
  ProxyRecord,
  StatusEvent,
  Tag
} from '@shared/types'
import type {
  CleanupResult,
  CleanupTarget,
  ClearResult,
  CookieFormat,
  ExportResult,
  ImportResult,
  KeyPreset,
  RetentionAlert,
  SessionPolicy,
  SessionRetention,
  SessionStats
} from '@shared/session'
import type { SettingView } from '@shared/settings'
import type { AccountConflict, AccountInput, AccountRecord, AutofillPlan, TotpCodeView } from '@shared/account'
import type { AssociationReport } from '@shared/association'
import type { TlsBaseline, TlsObservation, TlsProbeResult } from '@shared/tls'
import type { WebAuthnCredentialView, WebAuthnEnrollResult, WebAuthnStatus } from '@shared/webauthn'
import type { KernelReportView } from '@shared/kernel'
import type { FlowRecord, FlowValidation, RpaFlow, RunResult, RunSummary, StepLogEntry } from '@shared/rpa'
import type { ApiStatus } from '@shared/api'
import type {
  BackupInfo,
  HealthSummary,
  HistoryEntry,
  MonitorAlerts,
  PortImportResult,
  ProfileBundle,
  ProfileHealth,
  ResourceReport,
  ScheduleRecord,
  TrashItem,
  TrashKind
} from '@shared/ops'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!res.ok) throw new Error(res.error)
  return res.data
}

export interface RendererApi {
  app: {
    getInfo(): Promise<AppInfo>
    saveText(filename: string, content: string): Promise<{ path: string; bytes: number } | null>
    pickText(): Promise<{ path: string; name: string; content: string } | null>
    pickDirectory(defaultPath?: string): Promise<string | null>
    revealPath(target: string): Promise<boolean>
  }
  settings: {
    view(): Promise<SettingView[]>
    set(key: string, value: string | number | boolean | null): Promise<SettingView[]>
    reset(key: string): Promise<SettingView[]>
  }
  profiles: {
    list(filter?: ProfileFilter): Promise<ListResult<Profile>>
    get(id: string): Promise<Profile | null>
    create(input: ProfileInput): Promise<Profile>
    update(id: string, patch: Partial<ProfileInput>): Promise<Profile | null>
    remove(id: string): Promise<boolean>
    duplicate(id: string, name: string): Promise<Profile | null>
    regenerateFingerprint(id: string, seed?: string): Promise<FingerprintConfig | null>
    validateFingerprint(id: string): Promise<ConsistencyReport>
  }
  groups: {
    list(): Promise<Group[]>
    create(name: string, color?: string | null): Promise<Group>
    update(id: string, patch: { name?: string; color?: string | null; sortOrder?: number }): Promise<Group | null>
    remove(id: string): Promise<boolean>
  }
  tags: {
    list(): Promise<Tag[]>
    create(name: string, color?: string | null): Promise<Tag>
    remove(name: string): Promise<boolean>
  }
  proxies: {
    list(): Promise<ProxyRecord[]>
    usage(): Promise<Record<string, number>>
    bound(id: string): Promise<{ id: string; name: string; status: string }[]>
    create(input: ProxyInput & { password?: string | null }): Promise<ProxyRecord>
    update(id: string, patch: Partial<ProxyInput> & { password?: string | null }): Promise<ProxyRecord | null>
    remove(id: string): Promise<{ deleted: boolean; unbound: number }>
    check(id: string): Promise<{ ok: boolean; error: string | null; proxy: ProxyRecord | null }>
    checkAll(ids?: string[]): Promise<{ ok: number; failed: { id: string; error: string }[] }>
    import(text: string): Promise<{ imported: number; skipped: { line: string; reason: string }[] }>
  }
  browser: {
    start(profileId: string, opts?: { headless?: boolean; urls?: string[] }): Promise<BrowserLaunchResult>
    stop(profileId: string): Promise<boolean>
    stopAll(): Promise<void>
    active(profileId?: string): Promise<StatusEvent[] | StatusEvent | null>
  }
  session: {
    statsAll(): Promise<SessionStats[]>
    stats(profileId: string): Promise<SessionStats>
    refresh(profileId: string): Promise<SessionStats>
    export(
      profileId: string,
      opts?: { format?: CookieFormat; includeStorage?: boolean; origins?: string[] }
    ): Promise<ExportResult>
    import(profileId: string, content: string, format?: CookieFormat): Promise<ImportResult>
    clear(profileId: string, ignoreProtection?: boolean): Promise<ClearResult>
    cleanup(profileId: string, target: CleanupTarget): Promise<CleanupResult>
    setPolicy(profileId: string, policy: SessionPolicy): Promise<SessionStats>
    setRetention(profileId: string, retention: Partial<SessionRetention>): Promise<SessionStats>
    retentionAlerts(withinDays?: number): Promise<RetentionAlert[]>
    keyPresets(): Promise<KeyPreset[]>
  }
  detect: {
    run(profileId: string, samples?: number): Promise<DetectReport>
  }
  account: {
    list(profileId?: string): Promise<AccountRecord[]>
    get(id: string): Promise<AccountRecord | null>
    create(input: AccountInput): Promise<AccountRecord>
    update(id: string, patch: Partial<AccountInput>): Promise<AccountRecord | null>
    remove(id: string): Promise<boolean>
    totpCode(id: string): Promise<TotpCodeView>
    plan(id: string, includeTotp?: boolean): Promise<AutofillPlan>
    counts(): Promise<Record<string, number>>
    conflicts(): Promise<AccountConflict[]>
  }
  association: {
    check(): Promise<AssociationReport>
    checkProfile(profileId: string): Promise<AssociationReport>
  }
  tls: {
    probe(profileId: string, opts?: { targetUrl?: string; echoUrl?: string }): Promise<TlsProbeResult>
    promoteBaseline(profileId: string): Promise<TlsBaseline>
    baselines(): Promise<TlsBaseline[]>
    history(profileId: string, limit?: number): Promise<TlsObservation[]>
  }
  kernel: {
    report(): Promise<KernelReportView>
    useBranded(): Promise<KernelReportView>
    clearOverride(): Promise<KernelReportView>
    setPreferBranded(on: boolean): Promise<KernelReportView>
  }
  extensions: {
    list(): Promise<ExtensionRecord[]>
    usage(): Promise<Record<string, number>>
    boundProfiles(id: string): Promise<{ id: string; name: string }[]>
    install(dirPath: string): Promise<ExtensionRecord>
    installStore(urlOrId: string, name?: string): Promise<ExtensionRecord>
    installInProfile(extensionId: string, profileId: string): Promise<{ opened: number; url: string }>
    storeStatus(extensionId: string): Promise<{ profileId: string; name: string; installed: boolean }[]>
    uninstall(id: string): Promise<{ deleted: boolean; unbound: number }>
    toggle(id: string, enabled: boolean): Promise<ExtensionRecord | null>
    bind(extensionId: string, profileId: string): Promise<void>
    unbind(extensionId: string, profileId: string): Promise<void>
  }
  scheduler: {
    list(): Promise<ScheduleRecord[]>
    create(input: { flowId: string; cron: string; profileId: string; params?: Record<string, string>; enabled?: boolean }): Promise<ScheduleRecord>
    update(id: string, patch: { cron?: string; enabled?: boolean; params?: Record<string, string>; profileId?: string }): Promise<ScheduleRecord | null>
    remove(id: string): Promise<boolean>
    toggle(id: string, enabled: boolean): Promise<ScheduleRecord | null>
    runNow(id: string): Promise<boolean>
  }
  backup: {
    list(): Promise<BackupInfo[]>
    create(label?: string): Promise<BackupInfo>
    restore(id: string): Promise<{ preRestoreId: string }>
    remove(id: string): Promise<boolean>
    reveal(): Promise<boolean>
  }
  health: {
    summary(): Promise<HealthSummary>
    profile(profileId: string): Promise<ProfileHealth | null>
  }
  resources: {
    report(): Promise<ResourceReport>
  }
  port: {
    export(profileId: string): Promise<ProfileBundle>
    import(bundle: ProfileBundle, opts?: { name?: string }): Promise<PortImportResult>
  }
  history: {
    list(opts?: { limit?: number; profileId?: string }): Promise<HistoryEntry[]>
  }
  monitor: {
    alerts(): Promise<MonitorAlerts>
    runProxyCheck(): Promise<MonitorAlerts>
    runCookieCheck(): Promise<MonitorAlerts>
    runDriftCheck(): Promise<MonitorAlerts>
  }
  trash: {
    list(): Promise<TrashItem[]>
    restore(kind: TrashKind, id: string): Promise<boolean>
    purge(kind: TrashKind, id: string): Promise<boolean>
    empty(): Promise<number>
  }
  webauthn: {
    status(profileId: string): Promise<WebAuthnStatus>
    list(profileId: string): Promise<WebAuthnCredentialView[]>
    issues(profileId: string): Promise<string[]>
    enroll(
      profileId: string,
      input: { rpId: string; rpName?: string; userName?: string; origin?: string }
    ): Promise<WebAuthnEnrollResult>
    verify(profileId: string, credentialId: string, origin?: string): Promise<{ ok: boolean; message: string; signCount: number | null }>
    remove(id: string): Promise<boolean>
  }
  api: {
    status(): Promise<ApiStatus>
    start(): Promise<ApiStatus>
    stop(): Promise<ApiStatus>
    restart(): Promise<ApiStatus>
    generateToken(): Promise<ApiStatus>
    revealToken(): Promise<string>
  }
  rpa: {
    list(): Promise<FlowRecord[]>
    get(id: string): Promise<RpaFlow | null>
    create(flow: RpaFlow): Promise<FlowRecord>
    update(id: string, flow: RpaFlow): Promise<FlowRecord | null>
    remove(id: string): Promise<boolean>
    validate(flow: RpaFlow): Promise<FlowValidation>
    sample(): Promise<RpaFlow>
    run(flowId: string, profileId: string, params?: Record<string, string>): Promise<RunResult>
    stop(runId: string): Promise<boolean>
    runs(limit?: number): Promise<RunSummary[]>
    runLog(runId: string): Promise<{ summary: RunSummary | null; log: unknown[]; files: string[] } | null>
  }
  events: {
    onStatus(cb: (evt: StatusEvent) => void): () => void
    onLog(cb: (evt: LogEvent) => void): () => void
    onRpaStep(cb: (evt: StepLogEntry & { runId: string }) => void): () => void
    onReload(cb: () => void): () => void
  }
}

const api: RendererApi = {
  app: {
    getInfo: () => call<AppInfo>(IPC.APP_GET_INFO),
    saveText: (filename, content) =>
      call<{ path: string; bytes: number } | null>(IPC.APP_SAVE_TEXT, filename, content),
    pickText: () => call<{ path: string; name: string; content: string } | null>(IPC.APP_PICK_TEXT),
    pickDirectory: (defaultPath) => call<string | null>(IPC.APP_PICK_DIRECTORY, defaultPath),
    revealPath: (target) => call<boolean>(IPC.APP_REVEAL_PATH, target)
  },
  settings: {
    view: () => call<SettingView[]>(IPC.SETTINGS_VIEW),
    set: (key, value) => call<SettingView[]>(IPC.SETTINGS_SET, key, value),
    reset: (key) => call<SettingView[]>(IPC.SETTINGS_RESET, key)
  },
  profiles: {
    list: (filter) => call<ListResult<Profile>>(IPC.PROFILE_LIST, filter),
    get: (id) => call<Profile | null>(IPC.PROFILE_GET, id),
    create: (input) => call<Profile>(IPC.PROFILE_CREATE, input),
    update: (id, patch) => call<Profile | null>(IPC.PROFILE_UPDATE, id, patch),
    remove: (id) => call<boolean>(IPC.PROFILE_DELETE, id),
    duplicate: (id, name) => call<Profile | null>(IPC.PROFILE_DUPLICATE, id, name),
    regenerateFingerprint: (id, seed) => call<FingerprintConfig | null>(IPC.PROFILE_GENERATE_FINGERPRINT, id, seed),
    validateFingerprint: (id) => call<ConsistencyReport>(IPC.PROFILE_VALIDATE_FINGERPRINT, id)
  },
  groups: {
    list: () => call<Group[]>(IPC.GROUP_LIST),
    create: (name, color) => call<Group>(IPC.GROUP_CREATE, name, color),
    update: (id, patch) => call<Group | null>(IPC.GROUP_UPDATE, id, patch),
    remove: (id) => call<boolean>(IPC.GROUP_DELETE, id)
  },
  tags: {
    list: () => call<Tag[]>(IPC.TAG_LIST),
    create: (name, color) => call<Tag>(IPC.TAG_CREATE, name, color),
    remove: (name) => call<boolean>(IPC.TAG_DELETE, name)
  },
  proxies: {
    list: () => call<ProxyRecord[]>(IPC.PROXY_LIST),
    usage: () => call<Record<string, number>>(IPC.PROXY_USAGE),
    bound: (id) => call<{ id: string; name: string; status: string }[]>(IPC.PROXY_BOUND, id),
    create: (input) => call<ProxyRecord>(IPC.PROXY_CREATE, input),
    update: (id, patch) => call<ProxyRecord | null>(IPC.PROXY_UPDATE, id, patch),
    remove: (id) => call<{ deleted: boolean; unbound: number }>(IPC.PROXY_DELETE, id),
    check: (id) => call<{ ok: boolean; error: string | null; proxy: ProxyRecord | null }>(IPC.PROXY_CHECK, id),
    checkAll: (ids) =>
      call<{ ok: number; failed: { id: string; error: string }[] }>(IPC.PROXY_CHECK_ALL, ids),
    import: (text) => call<{ imported: number; skipped: { line: string; reason: string }[] }>(IPC.PROXY_IMPORT, text)
  },
  browser: {
    start: (profileId, opts) => call<BrowserLaunchResult>(IPC.BROWSER_START, profileId, opts),
    stop: (profileId) => call<boolean>(IPC.BROWSER_STOP, profileId),
    stopAll: () => call<void>(IPC.BROWSER_STOP_ALL),
    active: (profileId) => call<StatusEvent[] | StatusEvent | null>(IPC.BROWSER_ACTIVE, profileId),

  },
  session: {
    statsAll: () => call<SessionStats[]>(IPC.SESSION_STATS_ALL),
    stats: (profileId) => call<SessionStats>(IPC.SESSION_STATS, profileId),
    refresh: (profileId) => call<SessionStats>(IPC.SESSION_REFRESH, profileId),
    export: (profileId, opts) => call<ExportResult>(IPC.SESSION_EXPORT, profileId, opts),
    import: (profileId, content, format) => call<ImportResult>(IPC.SESSION_IMPORT, profileId, content, format),
    clear: (profileId, ignoreProtection) => call<ClearResult>(IPC.SESSION_CLEAR, profileId, ignoreProtection),
    cleanup: (profileId, target) => call<CleanupResult>(IPC.SESSION_CLEANUP, profileId, target),
    setPolicy: (profileId, policy) => call<SessionStats>(IPC.SESSION_SET_POLICY, profileId, policy),
    setRetention: (profileId, retention) => call<SessionStats>(IPC.SESSION_SET_RETENTION, profileId, retention),
    retentionAlerts: (withinDays) => call<RetentionAlert[]>(IPC.SESSION_RETENTION_ALERTS, withinDays),
    keyPresets: () => call<KeyPreset[]>(IPC.SESSION_KEY_PRESETS)
  },
  detect: {
    run: (profileId, samples) => call<DetectReport>(IPC.DETECT_RUN, profileId, samples)
  },
  account: {
    list: (profileId) => call<AccountRecord[]>(IPC.ACCOUNT_LIST, profileId),
    get: (id) => call<AccountRecord | null>(IPC.ACCOUNT_GET, id),
    create: (input) => call<AccountRecord>(IPC.ACCOUNT_CREATE, input),
    update: (id, patch) => call<AccountRecord | null>(IPC.ACCOUNT_UPDATE, id, patch),
    remove: (id) => call<boolean>(IPC.ACCOUNT_DELETE, id),
    totpCode: (id) => call<TotpCodeView>(IPC.ACCOUNT_TOTP, id),
    plan: (id, includeTotp) => call<AutofillPlan>(IPC.ACCOUNT_PLAN, id, includeTotp),
    counts: () => call<Record<string, number>>(IPC.ACCOUNT_COUNTS),
    conflicts: () => call<AccountConflict[]>(IPC.ACCOUNT_CONFLICTS)
  },
  association: {
    check: () => call<AssociationReport>(IPC.ASSOC_CHECK),
    checkProfile: (profileId) => call<AssociationReport>(IPC.ASSOC_CHECK_PROFILE, profileId)
  },
  tls: {
    probe: (profileId, opts) => call<TlsProbeResult>(IPC.TLS_PROBE, profileId, opts),
    promoteBaseline: (profileId) => call<TlsBaseline>(IPC.TLS_BASELINE_PROMOTE, profileId),
    baselines: () => call<TlsBaseline[]>(IPC.TLS_BASELINE_LIST),
    history: (profileId, limit) => call<TlsObservation[]>(IPC.TLS_HISTORY, profileId, limit)
  },
  kernel: {
    report: () => call<KernelReportView>(IPC.KERNEL_REPORT),
    useBranded: () => call<KernelReportView>(IPC.KERNEL_USE_BRANDED),
    clearOverride: () => call<KernelReportView>(IPC.KERNEL_CLEAR_OVERRIDE),
    setPreferBranded: (on) => call<KernelReportView>(IPC.KERNEL_SET_PREFER_BRANDED, on)
  },
  extensions: {
    list: () => call<ExtensionRecord[]>(IPC.EXT_LIST),
    usage: () => call<Record<string, number>>(IPC.EXT_USAGE),
    boundProfiles: (id) => call<{ id: string; name: string }[]>(IPC.EXT_BOUND_PROFILES, id),
    install: (dirPath) => call<ExtensionRecord>(IPC.EXT_INSTALL, dirPath),
    installStore: (urlOrId, name) => call<ExtensionRecord>(IPC.EXT_INSTALL_STORE, urlOrId, name),
    installInProfile: (extensionId, profileId) =>
      call<{ opened: number; url: string }>(IPC.EXT_INSTALL_IN_PROFILE, extensionId, profileId),
    storeStatus: (extensionId) =>
      call<{ profileId: string; name: string; installed: boolean }[]>(IPC.EXT_STORE_STATUS, extensionId),
    uninstall: (id) => call<{ deleted: boolean; unbound: number }>(IPC.EXT_UNINSTALL, id),
    toggle: (id, enabled) => call<ExtensionRecord | null>(IPC.EXT_TOGGLE, id, enabled),
    bind: (extensionId, profileId) => call<void>(IPC.EXT_BIND, extensionId, profileId),
    unbind: (extensionId, profileId) => call<void>(IPC.EXT_UNBIND, extensionId, profileId)
  },
  scheduler: {
    list: () => call<ScheduleRecord[]>(IPC.SCHED_LIST),
    create: (input) => call<ScheduleRecord>(IPC.SCHED_CREATE, input),
    update: (id, patch) => call<ScheduleRecord | null>(IPC.SCHED_UPDATE, id, patch),
    remove: (id) => call<boolean>(IPC.SCHED_DELETE, id),
    toggle: (id, enabled) => call<ScheduleRecord | null>(IPC.SCHED_TOGGLE, id, enabled),
    runNow: (id) => call<boolean>(IPC.SCHED_RUN_NOW, id)
  },
  backup: {
    list: () => call<BackupInfo[]>(IPC.BACKUP_LIST),
    create: (label) => call<BackupInfo>(IPC.BACKUP_CREATE, label),
    restore: (id) => call<{ preRestoreId: string }>(IPC.BACKUP_RESTORE, id),
    remove: (id) => call<boolean>(IPC.BACKUP_DELETE, id),
    reveal: () => call<boolean>(IPC.BACKUP_REVEAL)
  },
  health: {
    summary: () => call<HealthSummary>(IPC.HEALTH_SUMMARY),
    profile: (profileId) => call<ProfileHealth | null>(IPC.HEALTH_PROFILE, profileId)
  },
  resources: {
    report: () => call<ResourceReport>(IPC.RESOURCES_REPORT)
  },
  port: {
    export: (profileId) => call<ProfileBundle>(IPC.PORT_EXPORT, profileId),
    import: (bundle, opts) => call<PortImportResult>(IPC.PORT_IMPORT, bundle, opts)
  },
  history: {
    list: (opts) => call<HistoryEntry[]>(IPC.HISTORY_LIST, opts)
  },
  monitor: {
    alerts: () => call<MonitorAlerts>(IPC.MONITOR_ALERTS),
    runProxyCheck: () => call<MonitorAlerts>(IPC.MONITOR_RUN_PROXY),
    runCookieCheck: () => call<MonitorAlerts>(IPC.MONITOR_RUN_COOKIE),
    runDriftCheck: () => call<MonitorAlerts>(IPC.MONITOR_RUN_DRIFT)
  },
  trash: {
    list: () => call<TrashItem[]>(IPC.TRASH_LIST),
    restore: (kind, id) => call<boolean>(IPC.TRASH_RESTORE, kind, id),
    purge: (kind, id) => call<boolean>(IPC.TRASH_PURGE, kind, id),
    empty: () => call<number>(IPC.TRASH_EMPTY)
  },
  webauthn: {
    status: (profileId) => call<WebAuthnStatus>(IPC.WEBAUTHN_STATUS, profileId),
    list: (profileId) => call<WebAuthnCredentialView[]>(IPC.WEBAUTHN_LIST, profileId),
    issues: (profileId) => call<string[]>(IPC.WEBAUTHN_ISSUES, profileId),
    enroll: (profileId, input) => call<WebAuthnEnrollResult>(IPC.WEBAUTHN_ENROLL, profileId, input),
    verify: (profileId, credentialId, origin) =>
      call<{ ok: boolean; message: string; signCount: number | null }>(IPC.WEBAUTHN_VERIFY, profileId, credentialId, origin),
    remove: (id) => call<boolean>(IPC.WEBAUTHN_REMOVE, id)
  },
  api: {
    status: () => call<ApiStatus>(IPC.API_STATUS),
    start: () => call<ApiStatus>(IPC.API_START),
    stop: () => call<ApiStatus>(IPC.API_STOP),
    restart: () => call<ApiStatus>(IPC.API_RESTART),
    generateToken: () => call<ApiStatus>(IPC.API_GENERATE_TOKEN),
    revealToken: () => call<string>(IPC.API_REVEAL_TOKEN)
  },
  rpa: {
    list: () => call<FlowRecord[]>(IPC.RPA_LIST),
    get: (id) => call<RpaFlow | null>(IPC.RPA_GET, id),
    create: (flow) => call<FlowRecord>(IPC.RPA_CREATE, flow),
    update: (id, flow) => call<FlowRecord | null>(IPC.RPA_UPDATE, id, flow),
    remove: (id) => call<boolean>(IPC.RPA_DELETE, id),
    validate: (flow) => call<FlowValidation>(IPC.RPA_VALIDATE, flow),
    sample: () => call<RpaFlow>(IPC.RPA_SAMPLE),
    run: (flowId, profileId, params) => call<RunResult>(IPC.RPA_RUN, flowId, profileId, params),
    stop: (runId) => call<boolean>(IPC.RPA_STOP, runId),
    runs: (limit) => call<RunSummary[]>(IPC.RPA_RUNS, limit),
    runLog: (runId) =>
      call<{ summary: RunSummary | null; log: unknown[]; files: string[] } | null>(IPC.RPA_RUN_LOG, runId)
  },
  events: {
    onStatus: (cb) => {
      const listener = (_e: unknown, data: StatusEvent): void => cb(data)
      ipcRenderer.on(IPC.EVT_STATUS, listener)
      return () => ipcRenderer.removeListener(IPC.EVT_STATUS, listener)
    },
    onLog: (cb) => {
      const listener = (_e: unknown, data: LogEvent): void => cb(data)
      ipcRenderer.on(IPC.EVT_LOG, listener)
      return () => ipcRenderer.removeListener(IPC.EVT_LOG, listener)
    },
    onRpaStep: (cb) => {
      const listener = (_e: unknown, data: StepLogEntry & { runId: string }): void => cb(data)
      ipcRenderer.on(IPC.EVT_RPA_STEP, listener)
      return () => ipcRenderer.removeListener(IPC.EVT_RPA_STEP, listener)
    },
    onReload: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.EVT_RELOAD, listener)
      return () => ipcRenderer.removeListener(IPC.EVT_RELOAD, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
