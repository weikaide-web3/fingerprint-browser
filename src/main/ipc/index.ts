import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import * as profileService from '../services/profiles'
import * as browserService from '../services/browser'
import * as proxyService from '../services/proxies'
import * as sessionService from '../services/session'
import * as detectService from '../services/detect'
import * as apiService from '../services/api'
import * as rpaService from '../services/rpa'
import * as accountService from '../services/accounts'
import * as associationService from '../services/association'
import * as tlsService from '../services/tls'
import * as kernelService from '../services/kernel'
import * as extService from '../services/extensions'
import * as schedulerService from '../services/scheduler'
import * as backupService from '../services/backup'
import * as healthService from '../services/health'
import * as resourcesService from '../services/resources'
import * as portService from '../services/port'
import * as historyService from '../services/history'
import * as monitorService from '../services/monitor'
import * as trashService from '../services/trash'
import * as webauthnService from '../services/webauthn'
import * as groupsRepo from '../db/repositories/groups'
import { logAudit } from '../db/repositories/settings'
import { resetSetting, setTypedSetting, settingsView } from '../settings/defs'
import { dataDir, profilesRootDir, dbFile } from '../paths'
import { closeDatabase, initDatabase, isDbReady } from '../db'
import { encryptionStatus } from '../lib/crypto'
import { logError } from '../lib/log'
import type { ProfileFilter, ProfileInput, ProxyInput } from '@shared/types'
import type { CleanupTarget, CookieFormat, SessionPolicy, SessionRetention } from '@shared/session'
import type { AccountInput } from '@shared/account'
import { KEY_PRESETS } from '../session/retention'
import type { RpaFlow } from '@shared/rpa'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function handle<TArgs extends unknown[], TResult>(channel: string, fn: (...args: TArgs) => TResult | Promise<TResult>): void {
  ipcMain.handle(channel, async (_event, ...args: TArgs) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      logError('ipc', `${channel} 失败`, e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** 需要发送方窗口（弹系统对话框）的通道 */
function handleWin<TArgs extends unknown[], TResult>(
  channel: string,
  fn: (win: BrowserWindow | null, ...args: TArgs) => TResult | Promise<TResult>
): void {
  ipcMain.handle(channel, async (event, ...args: TArgs) => {
    try {
      return { ok: true, data: await fn(BrowserWindow.fromWebContents(event.sender), ...args) }
    } catch (e) {
      logError('ipc', `${channel} 失败`, e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** 只保留安全字符，避免对话框默认文件名被路径分隔符污染 */
function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'untitled'
}

/** 通知所有渲染窗口重新加载全部数据（用于备份恢复这类整库替换后） */
function broadcastReload(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.EVT_RELOAD)
  }
}

/**
 * 允许在 Finder 里打开的目录根。
 * 渲染进程只能拿到这些范围内的路径，防止它借 revealPath 探测/打开任意文件。
 */
function revealableRoots(): string[] {
  return [dataDir(), path.join(dataDir(), '..', 'backups'), profilesRootDir()]
}

/** 只打开主进程自己生成/记录过的路径（数据目录、导出快照、隔离目录） */
function assertRevealable(target: string): string {
  const real = fs.realpathSync(path.resolve(target))
  const ok = revealableRoots().some((root) => {
    try {
      const r = fs.realpathSync(root)
      return real === r || real.startsWith(r + path.sep)
    } catch {
      return false
    }
  })
  if (!ok) throw new Error(`路径不在允许范围内：${target}`)
  return real
}

export function registerIpc(): void {
  handle(IPC.APP_GET_INFO, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    dataDir: dataDir(),
    profilesDir: profilesRootDir(),
    apiBaseUrl: null,
    encryption: encryptionStatus()
  }))

  // APP_GET_SETTINGS / APP_SET_SETTING 已移除：
  // 前者会把 apiToken 等机密原样回传渲染进程，后者绕过 setTypedSetting 的全部校验，
  // 而渲染进程实际只用 settings.view / settings.set（带校验与掩码）。
  handle(IPC.SETTINGS_VIEW, () => settingsView())
  handle(IPC.SETTINGS_SET, (key: string, value: unknown) => {
    const def = setTypedSetting(key, value)
    logAudit('settings.set', 'setting', key, { value: def.type === 'secret' ? '***' : value })
    return settingsView()
  })
  handle(IPC.SETTINGS_RESET, (key: string) => {
    resetSetting(key)
    logAudit('settings.reset', 'setting', key)
    return settingsView()
  })

  handle(IPC.PROFILE_LIST, (filter?: ProfileFilter) => profileService.list(filter))
  handle(IPC.PROFILE_GET, (id: string) => profileService.get(id))
  handle(IPC.PROFILE_CREATE, (input: ProfileInput) => {
    if (!input?.name?.trim()) throw new Error('环境名称不能为空')
    const created = profileService.create(input)
    logAudit('profile.create', 'profile', created.id)
    return created
  })
  handle(IPC.PROFILE_UPDATE, (id: string, patch: Partial<ProfileInput>) => {
    const updated = profileService.update(id, patch)
    if (updated) logAudit('profile.update', 'profile', id)
    return updated
  })
  handle(IPC.PROFILE_DELETE, async (id: string) => {
    // 先停掉可能正在运行的内核，否则软删除后列表里消失但 Chrome 进程残留成孤儿
    await browserService.stopById(id).catch(() => undefined)
    profileService.remove(id)
    logAudit('profile.delete', 'profile', id)
    return true
  })
  handle(IPC.PROFILE_DUPLICATE, (id: string, name: string) => profileService.duplicate(id, name))
  handle(IPC.PROFILE_GENERATE_FINGERPRINT, (id: string, seed?: string) => profileService.regenerateFingerprint(id, seed))
  handle(IPC.PROFILE_VALIDATE_FINGERPRINT, (id: string) => {
    const report = profileService.validateProfileFingerprint(id)
    if (!report) throw new Error('环境不存在')
    return report
  })

  handle(IPC.GROUP_LIST, () => groupsRepo.listGroups())
  handle(IPC.GROUP_CREATE, (name: string, color?: string | null) => groupsRepo.createGroup(name, color))
  handle(IPC.GROUP_UPDATE, (id: string, patch: { name?: string; color?: string | null; sortOrder?: number }) =>
    groupsRepo.updateGroup(id, patch)
  )
  handle(IPC.GROUP_DELETE, (id: string) => {
    groupsRepo.deleteGroup(id)
    return true
  })
  handle(IPC.TAG_LIST, () => groupsRepo.listTags())
  handle(IPC.TAG_CREATE, (name: string, color?: string | null) => groupsRepo.createTag(name, color))
  handle(IPC.TAG_DELETE, (name: string) => {
    groupsRepo.deleteTag(name)
    return true
  })

  handle(IPC.PROXY_LIST, () => proxyService.list())
  handle(IPC.PROXY_USAGE, () => proxyService.usageCounts())
  handle(IPC.PROXY_BOUND, (id: string) => proxyService.boundProfiles(id))
  handle(IPC.PROXY_CREATE, (input: ProxyInput & { password?: string | null }) => {
    const created = proxyService.create(input)
    logAudit('proxy.create', 'proxy', created.id)
    return created
  })
  handle(IPC.PROXY_UPDATE, (id: string, patch: Partial<ProxyInput> & { password?: string | null }) => {
    const updated = proxyService.update(id, patch)
    if (updated) logAudit('proxy.update', 'proxy', id)
    return updated
  })
  handle(IPC.PROXY_DELETE, (id: string) => {
    const res = proxyService.remove(id)
    if (res.deleted) logAudit('proxy.delete', 'proxy', id, { unbound: res.unbound })
    return res
  })
  handle(IPC.PROXY_CHECK, async (id: string) => {
    const res = await proxyService.check(id)
    logAudit('proxy.check', 'proxy', id, { ok: res.ok, error: res.error })
    return res
  })
  handle(IPC.PROXY_CHECK_ALL, (ids?: string[]) => proxyService.checkAll(ids))
  handle(IPC.PROXY_IMPORT, (text: string) => {
    const res = proxyService.importText(text)
    logAudit('proxy.import', 'proxy', undefined, res)
    return res
  })

  handle(IPC.BROWSER_START, (profileId: string, opts?: { headless?: boolean; urls?: string[] }) =>
    browserService.startProfile(profileId, opts)
  )
  handle(IPC.BROWSER_STOP, (profileId: string) => browserService.stopById(profileId))
  handle(IPC.BROWSER_STOP_ALL, () => browserService.stopEverything())
  handle(IPC.BROWSER_ACTIVE, (profileId?: string) => {
    const map = browserService.runningStatusMap()
    if (profileId) return map[profileId] ?? null
    return Object.values(map)
  })
  // BROWSER_CLEAR_CACHE 已移除：它是个空实现（直接 return true），
  // 用户点「清理缓存」会看到成功但什么都没发生。
  // 真正的清理走 session:cleanup（target='cache'，会删 CACHE_DIRS 并回报释放字节数）。

  handle(IPC.SESSION_STATS_ALL, () => sessionService.statsAll())
  handle(IPC.SESSION_STATS, (profileId: string) => sessionService.stats(profileId))
  handle(IPC.SESSION_REFRESH, async (profileId: string) => {
    const stats = await sessionService.refreshStats(profileId)
    logAudit('session.refresh', 'profile', profileId, { cookies: stats.cookieCount })
    return stats
  })
  handle(
    IPC.SESSION_EXPORT,
    async (profileId: string, opts?: { format?: CookieFormat; includeStorage?: boolean; origins?: string[] }) => {
      const res = await sessionService.exportBundle(profileId, opts)
      logAudit('session.export', 'profile', profileId, { format: res.format, cookies: res.cookieCount })
      return res
    }
  )
  handle(IPC.SESSION_IMPORT, async (profileId: string, content: string, format?: CookieFormat) => {
    const res = await sessionService.importBundle(profileId, content, format)
    logAudit('session.import', 'profile', profileId, { added: res.added, total: res.total })
    return res
  })
  handle(IPC.SESSION_CLEAR, async (profileId: string) => {
    const res = await sessionService.clearCookies(profileId)
    logAudit('session.clear', 'profile', profileId, res)
    return res
  })
  handle(IPC.SESSION_CLEANUP, async (profileId: string, target: CleanupTarget) => {
    const res = await sessionService.cleanup(profileId, target)
    logAudit('session.cleanup', 'profile', profileId, res)
    return res
  })
  handle(IPC.SESSION_SET_POLICY, (profileId: string, policy: SessionPolicy) => {
    const stats = sessionService.setPolicy(profileId, policy)
    logAudit('session.policy', 'profile', profileId, { policy })
    return stats
  })

  handle(IPC.SESSION_SET_RETENTION, (profileId: string, retention: Partial<SessionRetention>) => {
    const stats = sessionService.updateRetention(profileId, retention)
    logAudit('session.retention', 'profile', profileId, {
      maxAgeDays: stats.retention.maxAgeDays,
      onExpire: stats.retention.onExpire,
      protectedKeys: stats.retention.protectedKeys.length
    })
    return stats
  })
  handle(IPC.SESSION_RETENTION_ALERTS, (withinDays?: number) => sessionService.retentionAlerts(withinDays ?? 7))
  handle(IPC.SESSION_KEY_PRESETS, () => KEY_PRESETS)

  handle(IPC.ACCOUNT_LIST, (profileId?: string) => accountService.list(profileId))
  handle(IPC.ACCOUNT_GET, (id: string) => accountService.get(id))
  handle(IPC.ACCOUNT_CREATE, (input: AccountInput) => {
    const created = accountService.create(input)
    logAudit('account.create', 'account', created.id, { platform: created.platform })
    return created
  })
  handle(IPC.ACCOUNT_UPDATE, (id: string, patch: Partial<AccountInput>) => {
    const updated = accountService.update(id, patch)
    logAudit('account.update', 'account', id)
    return updated
  })
  handle(IPC.ACCOUNT_DELETE, (id: string) => {
    const deleted = accountService.remove(id)
    logAudit('account.delete', 'account', id)
    return deleted
  })
  // 只回传一次性验证码，密钥永不出主进程
  handle(IPC.ACCOUNT_TOTP, (id: string) => {
    logAudit('account.totp', 'account', id)
    return accountService.currentTotpCode(id)
  })
  handle(IPC.ACCOUNT_PLAN, (id: string, includeTotp?: boolean) => accountService.buildAutofillPlan(id, { includeTotp }))
  handle(IPC.ACCOUNT_COUNTS, () => accountService.countsByProfile())
  handle(IPC.ACCOUNT_CONFLICTS, () => accountService.conflicts())

  handle(IPC.ASSOC_CHECK, () => associationService.checkAssociation())
  handle(IPC.ASSOC_CHECK_PROFILE, (profileId: string) => associationService.checkProfile(profileId))

  handle(IPC.TLS_PROBE, async (profileId: string, opts?: { targetUrl?: string; echoUrl?: string }) => {
    const report = await tlsService.probeTls(profileId, opts ?? {})
    logAudit('tls.probe', 'profile', profileId, { score: report.score, mismatch: report.mismatch })
    return report
  })
  handle(IPC.TLS_BASELINE_PROMOTE, (profileId: string) => {
    const b = tlsService.promoteBaseline(profileId)
    logAudit('tls.baseline', 'kernel', b.kernelVersion, { ja4: b.ja4 })
    return b
  })
  handle(IPC.TLS_BASELINE_LIST, () => tlsService.baselines())
  handle(IPC.TLS_HISTORY, (profileId: string, limit?: number) => tlsService.history(profileId, limit))

  handle(IPC.KERNEL_REPORT, () => kernelService.report())
  handle(IPC.KERNEL_USE_BRANDED, () => {
    const r = kernelService.useBrandedChrome()
    logAudit('kernel.useBranded', 'kernel', r.path, { previous: r.previous })
    return kernelService.report()
  })
  handle(IPC.KERNEL_CLEAR_OVERRIDE, () => {
    logAudit('kernel.clearOverride', 'kernel')
    return kernelService.report()
  })
  handle(IPC.KERNEL_SET_PREFER_BRANDED, (on: boolean) => {
    kernelService.setPreferBranded(Boolean(on))
    logAudit('kernel.preferBranded', 'kernel', String(on))
    return kernelService.report()
  })

  handle(IPC.DETECT_RUN, async (profileId: string, samples?: number) => {
    const report = await detectService.runDetection(profileId, { samples })
    logAudit('detect.run', 'profile', profileId, { score: report.score, mismatch: report.mismatch })
    if (!report.error) monitorService.setDriftBaseline(profileId, report.score)
    return report
  })

  handle(IPC.API_STATUS, () => apiService.status())
  handle(IPC.API_START, async () => {
    const s = await apiService.start()
    logAudit('api.start', 'setting', 'api', { port: s.port })
    return s
  })
  handle(IPC.API_STOP, async () => {
    const s = await apiService.stop()
    logAudit('api.stop', 'setting', 'api')
    return s
  })
  handle(IPC.API_RESTART, async () => {
    const s = await apiService.restart()
    logAudit('api.restart', 'setting', 'api', { port: s.port })
    return s
  })
  handle(IPC.API_GENERATE_TOKEN, () => {
    apiService.generateToken()
    return apiService.status()
  })
  // Token 只在用户显式点「显示」时单独取一次，不进 status() 轮询对象
  handle(IPC.API_REVEAL_TOKEN, () => apiService.revealToken())

  // ---------- RPA ----------
  handle(IPC.RPA_LIST, () => rpaService.flows())
  handle(IPC.RPA_GET, (id: string) => rpaService.flow(id))
  handle(IPC.RPA_CREATE, (flow: RpaFlow) => {
    const rec = rpaService.create(flow)
    logAudit('rpa.create', 'flow', rec.id, { steps: rec.stepCount })
    return rec
  })
  handle(IPC.RPA_UPDATE, (id: string, flow: RpaFlow) => {
    const rec = rpaService.update(id, flow)
    logAudit('rpa.update', 'flow', id)
    return rec
  })
  handle(IPC.RPA_DELETE, (id: string) => {
    rpaService.remove(id)
    logAudit('rpa.delete', 'flow', id)
    return true
  })
  handle(IPC.RPA_VALIDATE, (flow: RpaFlow) => rpaService.validate(flow))
  handle(IPC.RPA_SAMPLE, () => rpaService.sampleFlow())
  handle(IPC.RPA_RUNS, (limit?: number) => rpaService.runs(limit))
  handle(IPC.RPA_RUN_LOG, (runId: string) => rpaService.runLog(runId))
  handle(IPC.RPA_STOP, (runId: string) => rpaService.requestStop(runId))
  handle(IPC.RPA_RUN, async (flowId: string, profileId: string, params?: Record<string, string>) => {
    // runId 在执行开始前就有了，步骤日志才能被打上正确的标签
    let runId = ''
    const { run } = await rpaService.run({
      flowId,
      profileId,
      params,
      onStart: (id) => {
        runId = id
      },
      // 步骤日志实时推给界面：长流程要能看到跑到哪一步了
      onEvent: (e) => broadcast(IPC.EVT_RPA_STEP, { runId, ...e })
    })
    logAudit('rpa.run', 'flow', flowId, { profileId, status: run.status, ok: run.stats.ok, failed: run.stats.failed })
    return run
  })

  // 扩展管理
  handle(IPC.EXT_LIST, () => extService.list())
  handle(IPC.EXT_USAGE, () => extService.usage())
  handle(IPC.EXT_BOUND_PROFILES, (id: string) => extService.boundProfiles(id))
  handle(IPC.EXT_INSTALL, (dirPath: string) => {
    const created = extService.install(dirPath)
    logAudit('ext.install', 'extension', created.id)
    return created
  })
  handle(IPC.EXT_UNINSTALL, (id: string) => extService.uninstall(id))
  handle(IPC.EXT_TOGGLE, (id: string, enabled: boolean) => extService.toggle(id, enabled))
  handle(IPC.EXT_BIND, (extensionId: string, profileId: string) => extService.bind(extensionId, profileId))
  handle(IPC.EXT_UNBIND, (extensionId: string, profileId: string) => extService.unbind(extensionId, profileId))
  handle(IPC.EXT_INSTALL_STORE, (urlOrId: string, name?: string) => extService.installFromStore(urlOrId, name))
  handle(IPC.EXT_INSTALL_IN_PROFILE, async (extensionId: string, profileId: string) => {
    const url = extService.getStoreUrl(extensionId)
    if (!url) throw new Error('该扩展不是商店扩展')
    // 在目标环境里打开商店页：用户点一次「Add to Chrome」即原生安装到该 profile，跨重启保留
    const opened = await browserService.openUrls(profileId, [url])
    extService.bind(extensionId, profileId)
    return { opened, url }
  })
  handle(IPC.EXT_STORE_STATUS, (extensionId: string) => extService.storeInstallStatus(extensionId))

  // 定时调度
  handle(IPC.SCHED_LIST, () => schedulerService.list())
  handle(IPC.SCHED_CREATE, (input: { flowId: string; cron: string; profileId: string; params?: Record<string, string>; enabled?: boolean }) => {
    const created = schedulerService.create(input)
    logAudit('sched.create', 'schedule', created.id, { cron: input.cron })
    return created
  })
  handle(IPC.SCHED_UPDATE, (id: string, patch: { cron?: string; enabled?: boolean; params?: Record<string, string>; profileId?: string }) => {
    const updated = schedulerService.update(id, patch)
    if (updated) logAudit('sched.update', 'schedule', id)
    return updated
  })
  handle(IPC.SCHED_DELETE, (id: string) => {
    const ok = schedulerService.remove(id)
    if (ok) logAudit('sched.delete', 'schedule', id)
    return ok
  })
  handle(IPC.SCHED_TOGGLE, (id: string, enabled: boolean) => schedulerService.toggle(id, enabled))
  handle(IPC.SCHED_RUN_NOW, async (id: string) => {
    await schedulerService.runNow(id)
    return true
  })

  // Passkey / WebAuthn
  // 服务层（445 行）与集成测试早就有了，但没有界面入口 —— 用户根本没法注册 passkey。
  handle(IPC.WEBAUTHN_STATUS, (profileId: string) => webauthnService.status(profileId))
  handle(IPC.WEBAUTHN_LIST, (profileId: string) => webauthnService.list(profileId))
  handle(IPC.WEBAUTHN_ISSUES, (profileId: string) => webauthnService.issues(profileId))
  handle(IPC.WEBAUTHN_ENROLL, async (profileId: string, input: { rpId: string; rpName?: string; userName?: string; origin?: string }) => {
    const r = await webauthnService.enroll(profileId, input)
    logAudit('webauthn.enroll', 'profile', profileId, { rpId: r.rpId })
    return r
  })
  handle(IPC.WEBAUTHN_VERIFY, async (profileId: string, credentialId: string, origin?: string) => {
    const r = await webauthnService.verify(profileId, credentialId, origin)
    logAudit('webauthn.verify', 'profile', profileId, { ok: r.ok })
    return r
  })
  handle(IPC.WEBAUTHN_REMOVE, (id: string) => {
    const removed = webauthnService.remove(id)
    if (removed) logAudit('webauthn.remove', 'credential', id)
    return removed
  })

  // 备份 / 恢复
  handle(IPC.BACKUP_LIST, () => backupService.list())
  handle(IPC.BACKUP_CREATE, async (label?: string) => {
    const info = await backupService.create(label)
    logAudit('backup.create', 'backup', info.id)
    return info
  })
  handle(IPC.BACKUP_RESTORE, async (id: string) => {
    // 恢复是整库替换：先停掉所有内核（否则它们还在往 profiles/ 写），
    // 再关闭数据库连接（触发 WAL checkpoint），覆盖文件后重新打开。
    await browserService.stopEverything().catch((e) => logError('backup', '恢复前关闭环境失败', e))
    closeDatabase()
    try {
      const r = await backupService.restore(id)
      initDatabase(dbFile())
      logAudit('backup.restore', 'backup', id)
      broadcastReload()
      return r
    } finally {
      // 任何异常路径都要保证数据库重新打开，否则后续所有 IPC 都会崩
      if (!isDbReady()) initDatabase(dbFile())
    }
  })
  handle(IPC.BACKUP_DELETE, (id: string) => backupService.remove(id))
  handle(IPC.BACKUP_REVEAL, () => {
    void shell.openPath(backupService.revealDir())
    return true
  })

  // 健康度
  handle(IPC.HEALTH_SUMMARY, () => healthService.summary())
  handle(IPC.HEALTH_PROFILE, (profileId: string) => healthService.profileHealth(profileId))

  // 资源监控
  handle(IPC.RESOURCES_REPORT, () => resourcesService.report())

  // 环境导入 / 导出
  handle(IPC.PORT_EXPORT, (profileId: string) => portService.exportBundle(profileId))
  handle(IPC.PORT_IMPORT, (bundle: unknown, opts?: { name?: string }) => {
    const r = portService.importBundle(bundle as never, opts)
    logAudit('profile.import', 'profile', r.profileId)
    return r
  })

  // 操作历史
  handle(IPC.HISTORY_LIST, (opts?: { limit?: number; profileId?: string }) => historyService.history(opts))

  // 后台监控
  handle(IPC.MONITOR_ALERTS, () => monitorService.getAlerts())
  handle(IPC.MONITOR_RUN_PROXY, async () => {
    await monitorService.runProxyCheck()
    return monitorService.getAlerts()
  })
  handle(IPC.MONITOR_RUN_COOKIE, () => {
    monitorService.runCookieCheck()
    return monitorService.getAlerts()
  })
  handle(IPC.MONITOR_RUN_DRIFT, async () => {
    await monitorService.runDriftCheck()
    return monitorService.getAlerts()
  })

  // 回收站
  handle(IPC.TRASH_LIST, () => trashService.list())
  handle(IPC.TRASH_RESTORE, (kind: 'profile' | 'proxy' | 'extension', id: string) => {
    trashService.restore(kind, id)
    return true
  })
  handle(IPC.TRASH_PURGE, (kind: 'profile' | 'proxy' | 'extension', id: string) => {
    trashService.purge(kind, id)
    return true
  })
  handle(IPC.TRASH_EMPTY, () => trashService.empty())

  handleWin(IPC.APP_SAVE_TEXT, async (win, filename: string, content: string) => {
    const options: Electron.SaveDialogOptions = {
      title: '导出内容',
      defaultPath: path.join(os.homedir(), 'Downloads', safeFilename(filename)),
      filters: [
        { name: '文本', extensions: ['txt', 'json', 'csv'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return null
    fs.mkdirSync(path.dirname(res.filePath), { recursive: true })
    fs.writeFileSync(res.filePath, content, 'utf8')
    logAudit('app.save', 'file', res.filePath, { bytes: Buffer.byteLength(content) })
    return { path: res.filePath, bytes: Buffer.byteLength(content) }
  })

  handleWin(IPC.APP_PICK_TEXT, async (win) => {
    const options: Electron.OpenDialogOptions = {
      title: '选择要导入的文件',
      properties: ['openFile'],
      filters: [
        { name: 'Cookie / 会话', extensions: ['txt', 'json', 'cookies'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (res.canceled || !res.filePaths.length) return null
    const file = res.filePaths[0]
    return { path: file, name: path.basename(file), content: fs.readFileSync(file, 'utf8') }
  })

  handleWin(IPC.APP_PICK_DIRECTORY, async (win, defaultPath?: string) => {
    const options: Electron.OpenDialogOptions = {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || os.homedir()
    }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

  // 只打开主进程自己生成/记录过的路径（数据目录、导出快照、隔离目录）
  handle(IPC.APP_REVEAL_PATH, (target: string) => {
    if (!target) return false
    if (!fs.existsSync(target)) throw new Error(`路径不存在：${target}`)
    // shell.openPath 在 macOS 上走 LaunchServices，等于按扩展名执行任意程序，
    // 因此必须限定在白名单目录内 —— 否则被攻破的渲染进程可以打开任意文件。
    assertRevealable(target)
    void shell.openPath(target)
    return true
  })
}
