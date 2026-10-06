import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { app } from 'electron'
import { startApiServer, type ApiContext, type ApiServerHandle, type IpCheckResult } from '../api/server'
import * as profilesService from './profiles'
import * as browserService from './browser'
import * as proxiesService from './proxies'
import { parseExitInfo } from '../proxy/checker'
import { setSetting, logAudit, settingExists } from '../db/repositories/settings'
import { typedSetting } from '../settings/defs'
import { log, logError } from '../lib/log'
import type { ApiStatus } from '@shared/api'

/**
 * 自动化 API 的生命周期管理：把真实服务接进 ApiContext，并按设置项启停。
 * 服务只监听 127.0.0.1 —— 这些接口能任意驱动浏览器，绝不该暴露到局域网。
 */

let handle: ApiServerHandle | null = null
let starting: Promise<ApiServerHandle> | null = null

const BLANK_IP: IpCheckResult = {
  ok: false,
  error: null,
  ip: null,
  country: null,
  region: null,
  city: null,
  isp: null,
  timezone: null,
  latencyMs: null
}

/** 环境没绑代理时查本机直连出口，这样 /ip/check 对任何环境都有意义 */
async function directExit(): Promise<IpCheckResult> {
  const target = proxiesService.checkTarget()
  const started = Date.now()
  const body = await new Promise<string>((resolve, reject) => {
    const transport = target.tls ? https : http
    const req = transport.request(
      { host: target.host, port: target.port, path: target.path, method: 'GET', timeout: 10000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }
    )
    req.on('timeout', () => req.destroy(new Error('出口查询超时')))
    req.on('error', reject)
    req.end()
  }).catch((e: unknown) => {
    throw e instanceof Error ? e : new Error(String(e))
  })
  const { info, error } = parseExitInfo(body)
  if (!info) return { ...BLANK_IP, error: error ?? '无法解析出口信息' }
  return {
    ok: true,
    error: null,
    ip: info.ip,
    country: info.country,
    region: info.region,
    city: info.city,
    isp: info.isp,
    timezone: info.timezone,
    latencyMs: Date.now() - started
  }
}

async function checkIpByProfile(profileId: string): Promise<IpCheckResult> {
  const profile = profilesService.get(profileId)
  if (!profile) throw new Error(`环境不存在：${profileId}`)
  if (profile.proxyMode === 'bind' && profile.proxy) {
    const r = await proxiesService.check(profile.proxy.id)
    if (!r.ok || !r.proxy) return { ...BLANK_IP, error: r.error ?? '代理检测失败' }
    return {
      ok: true,
      error: null,
      ip: r.proxy.ip,
      country: r.proxy.country,
      region: r.proxy.region,
      city: r.proxy.city,
      isp: r.proxy.isp,
      timezone: r.proxy.timezone,
      latencyMs: r.proxy.latencyMs
    }
  }
  return directExit()
}

function buildContext(): ApiContext {
  return {
    appVersion: app.getVersion(),
    listProfiles: (filter) => profilesService.list(filter),
    getProfile: (id) => profilesService.get(id),
    createProfile: (input) => profilesService.create(input),
    updateProfile: (id, patch) => profilesService.update(id, patch),
    deleteProfile: (id) => profilesService.remove(id),
    startBrowser: (id, opts) => browserService.startProfile(id, { ...opts, headless: opts.headless ?? true }),
    stopBrowser: (id) => browserService.stopById(id),
    browserStatus: (id) => browserService.statusOf(id),
    activeBrowsers: () => browserService.activeStatusList(),
    openUrls: (id, urls) => browserService.openUrls(id, urls),
    checkIpByProfile,
    getToken: () => String(typedSetting<string>('apiToken', '')),
    onAudit: (action, targetId, detail) => logAudit(action, 'profile', targetId ?? '', detail)
  }
}

export type { ApiStatus }

export function status(): ApiStatus {
  const token = String(typedSetting<string>('apiToken', ''))
  return {
    running: Boolean(handle),
    port: handle?.port ?? null,
    baseUrl: handle?.baseUrl ?? null,
    authRequired: Boolean(token),
    tokenConfigured: Boolean(token),
    requests: handle?.requests ?? 0,
    enabled: typedSetting<boolean>('apiEnabled', true),
    configuredPort: typedSetting<number>('apiPort', 52222)
  }
}

/**
 * 显式取 Token：只在用户点「显示」时调用一次。
 *
 * 之前 status() 把完整 Token 一起回传，界面轮询一次就多泄漏一次；
 * 而渲染进程是整个应用里最容易被站点脚本波及的一侧（登录页本身就是攻击面）。
 */
export function revealToken(): string {
  logAudit('api.token.reveal', 'setting', 'apiToken')
  return String(typedSetting<string>('apiToken', ''))
}

/**
 * 幂等启动：已运行就直接返回当前状态。
 *
 * 首次启动（apiToken 从未被写入过）自动生成一个 Token。
 * 之前默认空 Token = 全部 /api/v1/* 无鉴权，而这些接口能删环境、
 * 能让内核带某套指纹访问任意 URL —— 开箱即裸奔不是可接受的默认。
 * 用户显式把 Token 清空（settingExists 为真但值为空）时尊重其选择。
 */
export async function start(): Promise<ApiStatus> {
  if (!typedSetting<boolean>('apiEnabled', true)) throw new Error('自动化 API 已在设置中关闭')
  if (handle) return status()
  if (starting) {
    await starting
    return status()
  }
  if (!settingExists('apiToken')) {
    generateToken()
    log('api', '首次启动已自动生成 API Token（可在「自动化 API」页查看/复制）')
  }
  starting = startApiServer(buildContext(), { port: typedSetting<number>('apiPort', 52222) })
  try {
    handle = await starting
  } finally {
    starting = null
  }
  return status()
}

export async function stop(): Promise<ApiStatus> {
  if (handle) {
    await handle.stop().catch((e: unknown) => logError('api', '停止失败', e))
    handle = null
  }
  return status()
}

/** 改了端口 / Token 后需要重启服务才生效 */
export async function restart(): Promise<ApiStatus> {
  await stop()
  return start()
}

export function generateToken(): string {
  const token = crypto.randomBytes(18).toString('hex')
  setSetting('apiToken', token)
  logAudit('api.token.rotate', 'setting', 'apiToken', { value: '***' })
  log('api', '已重新生成 API Token')
  return token
}

/**
 * 应用启动时按设置自动拉起；失败不影响主流程。
 * Token 的安全默认值由 start() 负责（覆盖界面手动启动这条路径）。
 */
export async function startIfEnabled(): Promise<void> {
  if (!typedSetting<boolean>('apiEnabled', true)) return
  try {
    await start()
  } catch (e) {
    logError('api', '自动启动失败', e)
  }
}