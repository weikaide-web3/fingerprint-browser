import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-channels'
import { launchProfile, stopProfile, stopAllProfiles } from '../browser/launcher'
import { allSessions, getStatus, getSession } from '../browser/registry'
import { awaitPageInjection } from '../fingerprint/injector'
import { getProfile, touchOpened, logUsage } from '../db/repositories/profiles'
import { applyClosePolicy, applyRetentionOnOpen } from './session'
import { requestStopForProfile } from './rpa'
import { log, logError } from '../lib/log'
import type { BrowserLaunchResult, Profile, StatusEvent } from '@shared/types'

export function broadcastStatus(evt: StatusEvent): void {
  // 测试环境（node 里跑 vitest）里 require('electron') 返回的是二进制路径字符串，
  // BrowserWindow 是 undefined —— 不能因为没窗口就崩掉启动流程。
  const wins = BrowserWindow?.getAllWindows?.() ?? []
  for (const win of wins) {
    if (!win.isDestroyed()) win.webContents.send(IPC.EVT_STATUS, evt)
  }
}

function alertMessage(a: { name: string; ageDays: number; onExpire: string }): string {
  const act = a.onExpire === 'clear_all' ? '已清空隔离目录' : '已清理 cookie（关键键保留）'
  return `登录态已使用 ${a.ageDays} 天，按保留策略${act}`
}

export async function startProfile(
  profileId: string,
  opts: { headless?: boolean; urls?: string[]; debugPort?: number; extraArgs?: string[] } = {}
): Promise<BrowserLaunchResult> {
  const profile: Profile | null = getProfile(profileId)
  if (!profile) throw new Error(`profile not found: ${profileId}`)
  // 并发上限由 launcher.doLaunch 统一把关：withContext（检测 / 会话 / RPA）
  // 也走那条路径，放在这里等于对「临时拉起」不设防。
  broadcastStatus({ profileId, status: 'starting' })
  try {
    // 登录态到期动作必须在内核起来之前处理完：
    // 带着一个「本该已过期」的会话去访问 Google/X，等于主动暴露设备不连续。
    const alert = await applyRetentionOnOpen(profileId)
    if (alert && alert.onExpire !== 'keep') broadcastStatus({ profileId, status: 'starting', message: alertMessage(alert) })
    const result = await launchProfile({
      profile,
      ...opts,
      onExit: () => {
        log('browser', `用户关闭窗口，${profileId} 已退出`)
        broadcastStatus({ profileId, status: 'stopped' })
      }
    })
    touchOpened(profileId)
    logUsage(profileId, 'open', { ws: result.wsEndpoint })
    broadcastStatus({ profileId, status: 'running', pid: result.pid, wsEndpoint: result.wsEndpoint })
    return result
  } catch (e) {
    broadcastStatus({ profileId, status: 'error', message: e instanceof Error ? e.message : String(e) })
    logError('browser', `启动失败 ${profileId}`, e)
    throw e
  }
}

export async function stopById(profileId: string): Promise<boolean> {
  // 先让跑在该环境上的 RPA 流程停下来：否则 runner 会在已关闭的 page 上继续执行，
  // 表现为一连串「Target page has been closed」报错，而且流程状态会被记成 failed。
  const stoppedFlows = requestStopForProfile(profileId)
  if (stoppedFlows) log('browser', `已请求停止 ${stoppedFlows} 个跑在 ${profileId} 上的 RPA 流程`)
  // 登录态策略要在进程退出前后分别处理：清 cookie 需要 CDP，删目录需要进程已退
  await applyClosePolicy(profileId, 'before-stop')
  const ok = await stopProfile(profileId)
  await applyClosePolicy(profileId, 'after-stop')
  logUsage(profileId, 'close')
  broadcastStatus({ profileId, status: ok ? 'stopped' : getStatus(profileId) })
  return ok
}

export async function stopEverything(): Promise<void> {
  const ids = allSessions().map((s) => s.profileId)
  for (const id of ids) await applyClosePolicy(id, 'before-stop')
  await stopAllProfiles()
  for (const id of ids) await applyClosePolicy(id, 'after-stop')
  for (const id of ids) broadcastStatus({ profileId: id, status: 'stopped' })
  log('browser', `已关闭全部环境 (${ids.length})`)
}

export function runningStatusMap(): Record<string, StatusEvent> {
  const out: Record<string, StatusEvent> = {}
  for (const s of allSessions()) {
    out[s.profileId] = { profileId: s.profileId, status: s.status, pid: s.pid, wsEndpoint: s.wsEndpoint }
  }
  return out
}

/** 没有 scheme 时按 https 处理：脚本里传 "example.com" 很常见 */
export function normalizeUrl(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s
  return `https://${s}`
}

/** 在已运行的环境里打开若干 URL（自动化 API 的 /browser/open 用它） */
export async function openUrls(profileId: string, urls: string[]): Promise<number> {
  const s = getSession(profileId)
  if (!s) throw new Error(`环境未运行：${profileId}，请先调用 /api/v1/browser/start`)
  let opened = 0
  for (const raw of urls) {
    const url = normalizeUrl(raw)
    if (!url) continue
    const page = await s.context.newPage()
    opened += 1
    // 等 CDP 覆盖落地后再导航，保证线上请求头是 profile 配置值
    await awaitPageInjection(page)
    // 不 await 导航结果：调用方要的是「页面已打开」，导航失败页面里会显示错误页
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: unknown) => {
      logError('browser', `打开 ${url} 失败`, e)
    })
  }
  return opened
}

export function statusOf(profileId: string): StatusEvent | null {
  const s = getSession(profileId)
  if (!s) return null
  return { profileId: s.profileId, status: s.status, pid: s.pid, wsEndpoint: s.wsEndpoint }
}

export function activeStatusList(): StatusEvent[] {
  return allSessions().map((s) => ({ profileId: s.profileId, status: s.status, pid: s.pid, wsEndpoint: s.wsEndpoint }))
}
