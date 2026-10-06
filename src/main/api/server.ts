import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { log, logError } from '../lib/log'
import type { BrowserLaunchResult, ListResult, Profile, ProfileFilter, ProfileInput, StatusEvent } from '@shared/types'

/**
 * 本机自动化 API：让 Selenium / Puppeteer / 脚本直接驱动环境。
 *
 * 响应体沿用 AdsPower 的 { code, msg, data } 形状，
 * 好处是已有的 AdsPower 脚本改个 base_url 就能跑，不用重写一遍业务代码。
 * 服务层通过 ApiContext 注入，因此这里可以完全脱离 Electron / SQLite 做单测。
 */

export interface IpCheckResult {
  ok: boolean
  error: string | null
  ip: string | null
  country: string | null
  region: string | null
  city: string | null
  isp: string | null
  timezone: string | null
  latencyMs: number | null
}

export interface ApiContext {
  appVersion: string
  listProfiles(filter?: ProfileFilter): ListResult<Profile>
  getProfile(id: string): Profile | null
  createProfile(input: ProfileInput): Profile
  updateProfile(id: string, patch: Partial<ProfileInput>): Profile | null
  deleteProfile(id: string): void
  startBrowser(profileId: string, opts: { headless?: boolean; urls?: string[] }): Promise<BrowserLaunchResult>
  stopBrowser(profileId: string): Promise<boolean>
  browserStatus(profileId: string): StatusEvent | null
  activeBrowsers(): StatusEvent[]
  openUrls(profileId: string, urls: string[]): Promise<number>
  checkIpByProfile(profileId: string): Promise<IpCheckResult>
  /** 空字符串表示不鉴权 */
  getToken(): string
  onAudit?(action: string, targetId?: string, detail?: unknown): void
}

export interface ApiServerHandle {
  port: number
  baseUrl: string
  authRequired: boolean
  requests: number
  stop(): Promise<void>
}

export interface ApiStartOptions {
  port?: number
  host?: string
  /** 覆盖 context.getToken()，测试用 */
  token?: string
}

const CODE = {
  ok: 0,
  error: 1,
  notFound: 2,
  unauthorized: 3,
  badRequest: 4
} as const

/**
 * 会改变状态的路由。
 *
 * AdsPower 的 Local API 用 GET 调 /browser/start，为了「改个 base_url 就能迁移」
 * 这个兼容性我们保留 GET。但只监听 127.0.0.1 并不等于安全：浏览器里的任意网页
 * 都能发简单 GET 请求（不需要 CORS 预检），恶意页面放一个
 * <img src="http://127.0.0.1:52222/api/v1/user/delete?user_id=x"> 就能删环境。
 *
 * 因此这里不靠 method，而是精确识别「浏览器发起的跨站请求」：
 * 这类请求一定带 Sec-Fetch-Site / Sec-Fetch-Mode / Origin，
 * 而 curl、Postman、Selenium 脚本不会带 —— 兼容性与安全性同时保住。
 */
const MUTATING_ROUTES = new Set([
  '/browser/start',
  '/browser/stop',
  '/browser/open',
  '/user/create',
  '/user/update',
  '/user/delete'
])

/**
 * 只接受指向本机的 Host。
 *
 * 不校验 Host 会被 DNS rebinding 绕过同源策略：恶意域名先把 A 记录指向公网，
 * 通过校验后再改到 127.0.0.1，浏览器就会把我们的响应当成同源数据读走 ——
 * /user/list 会泄漏全部环境名、代理 host:port 与指纹 seed。
 */
function isLocalHost(header: string): boolean {
  const h = header.trim().toLowerCase()
  if (!h) return false
  const host = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/** Origin / Referer 是否指向本机 */
function isLocalOrigin(value: string): boolean {
  try {
    const u = new URL(value)
    return isLocalHost(u.hostname)
  } catch {
    return false
  }
}

/**
 * 是否看起来像「浏览器发起的跨站请求」。
 * 返回 true 就必须拒绝：脚本客户端不带这些头，因此不受影响。
 */
function isCrossSiteBrowserRequest(req: http.IncomingMessage): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return true
  const mode = String(req.headers['sec-fetch-mode'] ?? '').toLowerCase()
  // navigate / no-cors 正是 <img>、<script>、<form> 产生的模式
  if (mode === 'navigate' || mode === 'no-cors') return true
  const origin = String(req.headers.origin ?? '')
  if (origin && !isLocalOrigin(origin)) return true
  const referer = String(req.headers.referer ?? '')
  if (referer && !isLocalOrigin(referer)) return true
  return false
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function ok<T>(res: http.ServerResponse, data: T): void {
  json(res, 200, { code: CODE.ok, msg: 'success', data })
}

function fail(res: http.ServerResponse, status: number, code: number, msg: string): void {
  json(res, status, { code, msg, data: null })
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c as string)
    size += buf.length
    // 本机接口也要防被大 body 打爆内存
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大（>4MB）')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  const type = String(req.headers['content-type'] ?? '')
  if (type.includes('application/json')) return JSON.parse(raw) as Record<string, unknown>
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw))
  }
  // 没写 content-type 但看起来是 JSON，也按 JSON 处理（脚本经常忘带 header）
  if (raw.startsWith('{')) return JSON.parse(raw) as Record<string, unknown>
  return {}
}

/** AdsPower 的 user_id 就是我们的 profile id，同时兼容用户传名字 */
function resolveUserId(ctx: ApiContext, raw: string | undefined): string | null {
  if (!raw) return null
  if (ctx.getProfile(raw)) return raw
  const byName = ctx.listProfiles({ search: raw, limit: 50 }).items.find((p) => p.name === raw)
  return byName?.id ?? null
}

function toApiProfile(p: Profile): Record<string, unknown> {
  return {
    user_id: p.id,
    browser_name: p.name,
    group_id: p.groupId,
    group_name: null,
    remark: p.note,
    browser_fingerprints_id: p.fingerprint?.seed ?? null,
    browser_version: p.fingerprint ? `${p.fingerprint.ua.browser} ${p.fingerprint.ua.major}` : null,
    os: p.fingerprint?.ua.os ?? null,
    proxy: p.proxy ? `${p.proxy.scheme}://${p.proxy.host}:${p.proxy.port}` : null,
    ip: p.proxy?.ip ?? null,
    created_time: p.createdAt,
    updated_time: p.updatedAt,
    launch_count: p.openCount
  }
}

function toWsPayload(r: BrowserLaunchResult): Record<string, unknown> {
  const port = Number(new URL(r.httpEndpoint).port)
  return {
    // selenium 给的是 CDP 的 ws 端点，puppeteer/playwright 用 http 端点 connectOverCDP
    ws: { selenium: r.wsEndpoint, puppeteer: r.httpEndpoint },
    websocket: r.wsEndpoint,
    http: r.httpEndpoint,
    debug_port: port,
    pid: r.pid,
    driver: '',
    user_id: r.profileId
  }
}

async function handleRequest(
  ctx: ApiContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  meta: { requests: number; startedAt: number }
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  // Host 校验先于一切（包括 /health）：DNS rebinding 场景下攻击页面能以同源身份读响应
  if (!isLocalHost(String(req.headers.host ?? ''))) {
    fail(res, 403, CODE.error, 'Host 非法：本服务只接受指向 127.0.0.1 / localhost 的请求')
    return
  }

  const token = ctx.getToken()
  const provided =
    (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('token') ||
    String(req.headers['x-api-key'] ?? '')

  if (path === '/health' || path === '/') {
    ok(res, {
      app: 'fingerprint-browser',
      version: ctx.appVersion,
      uptimeMs: Date.now() - meta.startedAt,
      requests: meta.requests,
      authRequired: Boolean(token)
    })
    return
  }

  if (token && !safeEqual(provided, token)) {
    fail(res, 401, CODE.unauthorized, '缺少或错误的 API Token：请用 Authorization: Bearer <token> 或 ?token=')
    return
  }

  if (!path.startsWith('/api/v1/')) {
    fail(res, 404, CODE.notFound, `未知接口：${path}`)
    return
  }

  let body: Record<string, unknown> = {}
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readBody(req)
    } catch (e) {
      fail(res, 400, CODE.badRequest, e instanceof Error ? e.message : String(e))
      return
    }
  }
  const param = (name: string): string | undefined => {
    const v = url.searchParams.get(name)
    if (v !== null) return v
    const b = body[name]
    return b === undefined || b === null ? undefined : String(b)
  }

  const route = path.slice('/api/v1'.length)

  // 浏览器发起的跨站请求一律拒绝状态变更：见 MUTATING_ROUTES 注释里的 CSRF 场景。
  // 脚本客户端（curl / Selenium / Postman）不带这些头，因此 AdsPower 兼容不受影响。
  if (MUTATING_ROUTES.has(route) && isCrossSiteBrowserRequest(req)) {
    return fail(res, 403, CODE.error, `${route} 拒绝来自浏览器的跨站调用（请用脚本带 Token 调用）`)
  }

  try {
    if (route === '/browser/start') {
      const userId = resolveUserId(ctx, param('user_id'))
      if (!userId) return fail(res, 400, CODE.badRequest, 'user_id 不存在')
      const headless = param('headless') === '1' || param('headless') === 'true'
      const urls = (param('urls') ?? param('url') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const result = await ctx.startBrowser(userId, { headless, urls: urls.length ? urls : undefined })
      ctx.onAudit?.('api.browser.start', userId)
      return ok(res, toWsPayload(result))
    }

    if (route === '/browser/stop') {
      const userId = resolveUserId(ctx, param('user_id'))
      if (!userId) return fail(res, 400, CODE.badRequest, 'user_id 不存在')
      const stopped = await ctx.stopBrowser(userId)
      ctx.onAudit?.('api.browser.stop', userId)
      return ok(res, { user_id: userId, stopped })
    }

    if (route === '/browser/status') {
      const userId = resolveUserId(ctx, param('user_id'))
      if (!userId) return fail(res, 400, CODE.badRequest, 'user_id 不存在')
      const s = ctx.browserStatus(userId)
      return ok(res, { user_id: userId, status: s ? 'running' : 'inactive', ws: s?.wsEndpoint ?? null, pid: s?.pid ?? null })
    }

    if (route === '/browser/active') {
      const list = ctx.activeBrowsers().map((s) => ({ user_id: s.profileId, status: 'running', ws: s.wsEndpoint, pid: s.pid }))
      return ok(res, { total: list.length, user_data: list })
    }

    if (route === '/browser/open') {
      const userId = resolveUserId(ctx, param('user_id'))
      if (!userId) return fail(res, 400, CODE.badRequest, 'user_id 不存在')
      const urls = (param('urls') ?? param('url') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (!urls.length) return fail(res, 400, CODE.badRequest, '缺少 url')
      const opened = await ctx.openUrls(userId, urls)
      return ok(res, { user_id: userId, opened })
    }

    if (route === '/user/list') {
      const pageNo = Math.max(1, Number(param('page_no') ?? 1))
      const pageSize = Math.min(200, Math.max(1, Number(param('page_size') ?? 100)))
      const all = ctx.listProfiles({ search: param('browser_name') ?? param('search'), limit: 500 }).items
      const start = (pageNo - 1) * pageSize
      return ok(res, {
        total: all.length,
        page: pageNo,
        page_size: pageSize,
        user_data: all.slice(start, start + pageSize).map(toApiProfile)
      })
    }

    if (route === '/user/create') {
      const name = param('browser_name') ?? param('name')
      if (!name?.trim()) return fail(res, 400, CODE.badRequest, '缺少 browser_name')
      const created = ctx.createProfile({
        name: name.trim(),
        groupId: param('group_id') ?? null,
        note: param('remark') ?? null
      })
      ctx.onAudit?.('api.user.create', created.id)
      return ok(res, { user_id: created.id, browser_name: created.name })
    }

    if (route === '/user/update') {
      const userId = resolveUserId(ctx, param('user_id'))
      if (!userId) return fail(res, 400, CODE.badRequest, 'user_id 不存在')
      const patch: Partial<ProfileInput> = {}
      const name = param('browser_name')
      if (name !== undefined) patch.name = name
      const remark = param('remark')
      if (remark !== undefined) patch.note = remark
      const groupId = param('group_id')
      if (groupId !== undefined) patch.groupId = groupId || null
      const updated = ctx.updateProfile(userId, patch)
      if (!updated) return fail(res, 404, CODE.notFound, '环境不存在')
      ctx.onAudit?.('api.user.update', userId)
      return ok(res, toApiProfile(updated))
    }

    if (route === '/user/delete') {
      const userId = resolveUserId(ctx, param('user_id'))
      if (!userId) return fail(res, 400, CODE.badRequest, 'user_id 不存在')
      ctx.deleteProfile(userId)
      ctx.onAudit?.('api.user.delete', userId)
      return ok(res, { user_id: userId, deleted: true })
    }

    if (route === '/ip/check') {
      const userId = resolveUserId(ctx, param('user_id'))
      if (!userId) return fail(res, 400, CODE.badRequest, 'user_id 不存在')
      const r = await ctx.checkIpByProfile(userId)
      if (!r.ok) return fail(res, 200, CODE.error, r.error ?? '出口检测失败')
      return ok(res, {
        user_id: userId,
        ip: r.ip,
        country: r.country,
        region: r.region,
        city: r.city,
        isp: r.isp,
        timezone: r.timezone,
        latency_ms: r.latencyMs
      })
    }

    return fail(res, 404, CODE.notFound, `未知接口：${path}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('api', `${req.method} ${path} 失败`, e)
    return fail(res, 500, CODE.error, msg)
  }
}

export async function startApiServer(ctx: ApiContext, opts: ApiStartOptions = {}): Promise<ApiServerHandle> {
  const startedAt = Date.now()
  const meta = { requests: 0, startedAt }
  const host = opts.host ?? '127.0.0.1'
  const server = http.createServer((req, res) => {
    meta.requests += 1
    void handleRequest(ctx, req, res, meta).catch((e: unknown) => {
      logError('api', '未处理的请求异常', e)
      if (!res.headersSent) fail(res, 500, CODE.error, e instanceof Error ? e.message : String(e))
      else res.destroy()
    })
  })

  // 端口被占用时退回随机端口：API 端口写进文档给用户，但冲突不该让功能整个不可用
  const preferred = opts.port && opts.port > 0 ? opts.port : 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(preferred, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  }).catch((e: unknown) => {
    if (!preferred) throw e
    log('api', `端口 ${preferred} 被占用，改用随机端口：${e instanceof Error ? e.message : e}`)
    return new Promise<void>((resolve, reject) => {
      server.removeAllListeners('error')
      server.once('error', reject)
      server.listen(0, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  })

  server.on('error', (e) => logError('api', 'API 服务错误', e))
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://${host}:${port}`
  log('api', `自动化 API 已启动 ${baseUrl}（${ctx.getToken() ? '需要 Token' : '无鉴权'}）`)

  return {
    port,
    baseUrl,
    authRequired: Boolean(ctx.getToken()),
    get requests() {
      return meta.requests
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}