import { DEFAULT_RETENTION } from '@shared/session'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { startApiServer, type ApiContext, type ApiServerHandle, type IpCheckResult } from '../../src/main/api/server'
import type { BrowserLaunchResult, ListResult, Profile, ProfileInput, StatusEvent } from '@shared/types'

/**
 * 自动化 API 单测：用假的 ApiContext 起真实 HTTP 服务打真实请求。
 * 这样测的是「脚本实际会看到什么」，包括鉴权、参数位置、响应形状，
 * 而不是只测内部函数。
 */

function makeProfile(id: string, name: string): Profile {
  const ts = Date.now()
  return {
    id,
    name,
    groupId: null,
    color: null,
    icon: null,
    note: null,
    kernel: 'chromium',
    fingerprintMode: 'auto',
    proxyMode: 'none',
    proxyId: null,
    userDataDir: `/tmp/${id}`,
    startupUrls: [],
    launchArgs: [],
    sessionPolicy: 'keep',
    retention: DEFAULT_RETENTION,
    archived: 0,
    status: 'stopped',
    openCount: 0,
    lastOpenedAt: null,
    createdAt: ts,
    updatedAt: ts,
    tags: [],
    fingerprint: null,
    proxy: null
  }
}

interface Harness {
  ctx: ApiContext
  store: Map<string, Profile>
  running: Map<string, StatusEvent>
  audits: string[]
}

function harness(token = ''): Harness {
  const store = new Map<string, Profile>([['p1', makeProfile('p1', '账号 A')]])
  const running = new Map<string, StatusEvent>()
  const audits: string[] = []
  const ctx: ApiContext = {
    appVersion: 'test',
    listProfiles: (filter): ListResult<Profile> => {
      const q = (filter?.search ?? '').toLowerCase()
      const items = [...store.values()].filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q))
      return { items: items.slice(0, filter?.limit ?? items.length), total: items.length }
    },
    getProfile: (id) => store.get(id) ?? null,
    createProfile: (input: ProfileInput) => {
      const p = makeProfile(`p${store.size + 1}`, input.name)
      p.note = input.note ?? null
      p.groupId = input.groupId ?? null
      store.set(p.id, p)
      return p
    },
    updateProfile: (id, patch) => {
      const p = store.get(id)
      if (!p) return null
      if (patch.name !== undefined) p.name = patch.name
      if (patch.note !== undefined) p.note = patch.note
      if (patch.groupId !== undefined) p.groupId = patch.groupId
      store.set(id, p)
      return p
    },
    deleteProfile: (id) => {
      store.delete(id)
    },
    startBrowser: async (id, opts): Promise<BrowserLaunchResult> => {
      if (!store.has(id)) throw new Error(`profile not found: ${id}`)
      const r: BrowserLaunchResult = {
        profileId: id,
        wsEndpoint: `ws://127.0.0.1:9333/devtools/browser/${id}`,
        httpEndpoint: 'http://127.0.0.1:9333',
        pid: 4242,
        startedAt: Date.now()
      }
      running.set(id, { profileId: id, status: 'running', pid: r.pid, wsEndpoint: r.wsEndpoint })
      void opts
      return r
    },
    stopBrowser: async (id) => running.delete(id),
    browserStatus: (id) => running.get(id) ?? null,
    activeBrowsers: () => [...running.values()],
    openUrls: async (id, urls) => {
      if (!running.has(id)) throw new Error(`环境未运行：${id}，请先调用 /api/v1/browser/start`)
      return urls.length
    },
    checkIpByProfile: async (): Promise<IpCheckResult> => ({
      ok: true,
      error: null,
      ip: '203.0.113.9',
      country: 'US',
      region: 'CA',
      city: 'San Jose',
      isp: 'Test ISP',
      timezone: 'America/Los_Angeles',
      latencyMs: 42
    }),
    getToken: () => token,
    onAudit: (action, targetId) => audits.push(`${action}:${targetId ?? ''}`)
  }
  return { ctx, store, running, audits }
}

let server: ApiServerHandle
let base = ''
const h = harness()

function req(path: string, opts: { method?: string; token?: string; body?: unknown; form?: string } = {}): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path)
    const headers: Record<string, string> = {}
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    let payload: string | undefined
    if (opts.form) {
      payload = opts.form
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body)
      headers['Content-Type'] = 'application/json'
    }
    const r = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, raw })
        })
      }
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

beforeAll(async () => {
  server = await startApiServer(h.ctx, { port: 0 })
  base = server.baseUrl
})

afterAll(async () => {
  await server.stop()
})

describe('自动化 API（AdsPower 兼容形状）', () => {
  it('/health 不需要 Token，返回应用信息', async () => {
    const r = await req('/health')
    expect(r.status).toBe(200)
    expect(r.json.code).toBe(0)
    expect(r.json.data.app).toBe('fingerprint-browser')
    expect(r.json.data.authRequired).toBe(false)
  })

  it('未知接口返回 code=2 且形状一致', async () => {
    const r = await req('/api/v1/nope')
    expect(r.status).toBe(404)
    expect(r.json.code).toBe(2)
    expect(r.json.data).toBeNull()
  })

  it('user/list 返回 user_data 并支持分页与按名搜索', async () => {
    h.store.set('p2', makeProfile('p2', '账号 B'))
    const all = await req('/api/v1/user/list')
    expect(all.json.data.total).toBe(2)
    expect(all.json.data.user_data[0].user_id).toBeTruthy()
    expect(all.json.data.user_data[0].browser_name).toBeTruthy()

    const paged = await req('/api/v1/user/list?page_no=2&page_size=1')
    expect(paged.json.data.user_data).toHaveLength(1)

    const search = await req('/api/v1/user/list?browser_name=账号 B')
    expect(search.json.data.total).toBe(1)
    expect(search.json.data.user_data[0].user_id).toBe('p2')
  })

  it('create / update / delete 全流程', async () => {
    const created = await req('/api/v1/user/create', { method: 'POST', body: { browser_name: '脚本建的', remark: 'hi' } })
    expect(created.json.code).toBe(0)
    const id = created.json.data.user_id
    expect(h.store.get(id)?.note).toBe('hi')

    const updated = await req('/api/v1/user/update', { method: 'POST', body: { user_id: id, remark: '改过了' } })
    expect(updated.json.code).toBe(0)
    expect(h.store.get(id)?.note).toBe('改过了')

    const removed = await req(`/api/v1/user/delete?user_id=${id}`)
    expect(removed.json.data.deleted).toBe(true)
    expect(h.store.has(id)).toBe(false)
  })

  it('缺 browser_name 时报参数错误而不是 500', async () => {
    const r = await req('/api/v1/user/create', { method: 'POST', body: {} })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe(4)
    expect(r.json.msg).toContain('browser_name')
  })

  it('user_id 不存在的 start 返回 400', async () => {
    const r = await req('/api/v1/browser/start?user_id=nope')
    expect(r.status).toBe(400)
    expect(h.running.size).toBe(0)
  })

  it('start 返回 selenium/puppeteer 两种端点，status 与 active 能看到运行中', async () => {
    const started = await req('/api/v1/browser/start?user_id=p1&headless=1')
    expect(started.json.code).toBe(0)
    const d = started.json.data
    expect(d.ws.selenium).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//)
    expect(d.ws.puppeteer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(d.debug_port).toBe(9333)
    expect(d.user_id).toBe('p1')

    const st = await req('/api/v1/browser/status?user_id=p1')
    expect(st.json.data.status).toBe('running')

    const active = await req('/api/v1/browser/active')
    expect(active.json.data.total).toBe(1)
    expect(active.json.data.user_data[0].user_id).toBe('p1')

    const opened = await req('/api/v1/browser/open?user_id=p1&urls=https://a.com,https://b.com')
    expect(opened.json.data.opened).toBe(2)

    const stopped = await req('/api/v1/browser/stop?user_id=p1')
    expect(stopped.json.data.stopped).toBe(true)
    const after = await req('/api/v1/browser/status?user_id=p1')
    expect(after.json.data.status).toBe('inactive')
  })

  it('环境未运行时 open 报错并给出可操作的提示', async () => {
    const r = await req('/api/v1/browser/open?user_id=p1&urls=https://a.com')
    expect(r.json.code).toBe(1)
    expect(r.json.msg).toContain('browser/start')
  })

  it('支持用环境名当 user_id（AdsPower 用户常这么写）', async () => {
    const r = await req('/api/v1/browser/status?user_id=' + encodeURIComponent('账号 A'))
    expect(r.json.code).toBe(0)
    expect(r.json.data.user_id).toBe('p1')
  })

  it('表单编码与不带 content-type 的 JSON 都能解析', async () => {
    const form = await req('/api/v1/user/create', { method: 'POST', form: 'browser_name=表单建的' })
    expect(form.json.code).toBe(0)

    const raw = await new Promise<{ code: number }>((resolve, reject) => {
      const u = new URL(base + '/api/v1/user/create')
      const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST' }, (res) => {
        const c: Buffer[] = []
        res.on('data', (x: Buffer) => c.push(x))
        res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8'))))
      })
      rq.on('error', reject)
      rq.end(JSON.stringify({ browser_name: '裸 JSON' }))
    })
    expect(raw.code).toBe(0)
  })

  it('ip/check 返回出口信息', async () => {
    const r = await req('/api/v1/ip/check?user_id=p1')
    expect(r.json.code).toBe(0)
    expect(r.json.data.ip).toBe('203.0.113.9')
    expect(r.json.data.timezone).toBe('America/Los_Angeles')
  })

  it('API 操作会写审计', () => {
    expect(h.audits).toContain('api.browser.start:p1')
    expect(h.audits).toContain('api.browser.stop:p1')
  })

  it('配置 Token 后：无 Token 401、错 Token 401、Header/Query 对 Token 200', async () => {
    const authed = harness('secret-token')
    const s = await startApiServer(authed.ctx, { port: 0 })
    const old = base
    try {
      base = s.baseUrl
      expect(s.authRequired).toBe(true)
      expect((await req('/health')).status).toBe(200)

      expect((await req('/api/v1/user/list')).status).toBe(401)
      expect((await req('/api/v1/user/list', { token: 'wrong' })).status).toBe(401)
      expect((await req('/api/v1/user/list?token=secret-token')).status).toBe(200)
      expect((await req('/api/v1/user/list', { token: 'secret-token' })).status).toBe(200)
    } finally {
      base = old
      await s.stop()
    }
  })

  it('端口被占用时退回随机端口而不是启动失败', async () => {
    const first = await startApiServer(harness().ctx, { port: 0 })
    const taken = first.port
    const second = await startApiServer(harness().ctx, { port: taken })
    try {
      expect(second.port).not.toBe(taken)
      const code = await new Promise<number>((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: second.port, path: '/health' }, (res) => resolve(res.statusCode ?? 0))
        rq.on('error', reject)
        rq.end()
      })
      expect(code).toBe(200)
    } finally {
      await first.stop()
      await second.stop()
    }
  })
})