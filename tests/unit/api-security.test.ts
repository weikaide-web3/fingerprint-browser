import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { startApiServer, type ApiContext, type ApiServerHandle, type IpCheckResult } from '../../src/main/api/server'
import { DEFAULT_RETENTION } from '@shared/session'
import type { BrowserLaunchResult, ListResult, Profile, ProfileInput, StatusEvent } from '@shared/types'

/**
 * 自动化 API 的安全边界回归测试。
 *
 * 这些接口只监听 127.0.0.1，但「只监听本机」不等于安全：
 * 1. 浏览器里的任意网页都能发简单 GET（不需要 CORS 预检）→ CSRF 可删环境；
 * 2. DNS rebinding 能让恶意域名以同源身份读走 /user/list（泄漏环境名、
 *    代理 host:port、指纹 seed）。
 * 所以必须测：Host 白名单、跨站浏览器请求拦截、Token 不回传渲染进程。
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

function harness(token = '') {
  const store = new Map<string, Profile>([['p1', makeProfile('p1', '账号 A')]])
  const running = new Map<string, StatusEvent>()
  const ctx: ApiContext = {
    appVersion: 'test',
    listProfiles: (filter): ListResult<Profile> => ({ items: [...store.values()].slice(0, filter?.limit ?? 500), total: store.size }),
    getProfile: (id) => store.get(id) ?? null,
    createProfile: (input: ProfileInput) => {
      const p = makeProfile(`p${store.size + 1}`, input.name)
      store.set(p.id, p)
      return p
    },
    updateProfile: (id, patch) => {
      const p = store.get(id)
      if (!p) return null
      if (patch.name !== undefined) p.name = patch.name
      return p
    },
    deleteProfile: (id) => {
      store.delete(id)
    },
    startBrowser: async (id): Promise<BrowserLaunchResult> => ({
      profileId: id,
      wsEndpoint: `ws://127.0.0.1:9333/devtools/browser/${id}`,
      httpEndpoint: 'http://127.0.0.1:9333',
      pid: 4242,
      startedAt: Date.now()
    }),
    stopBrowser: async (id) => running.delete(id),
    browserStatus: (id) => running.get(id) ?? null,
    activeBrowsers: () => [...running.values()],
    openUrls: async () => 1,
    checkIpByProfile: async (): Promise<IpCheckResult> => ({
      ok: true,
      error: null,
      ip: '203.0.113.9',
      country: 'US',
      region: null,
      city: null,
      isp: null,
      timezone: null,
      latencyMs: 1
    }),
    getToken: () => token
  }
  return { ctx, store, running }
}

let server: ApiServerHandle
let base = ''
const h = harness('secret-token')

beforeAll(async () => {
  server = await startApiServer(h.ctx, { token: 'secret-token' })
  base = server.baseUrl
})

afterAll(async () => {
  await server?.stop()
})

function req(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; token?: string } = {}
): Promise<{ status: number; json: { code: number; msg: string } }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path)
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
    const r = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
      }
    )
    r.on('error', reject)
    r.end()
  })
}

describe('Host 白名单（防 DNS rebinding）', () => {
  it('非本机 Host 一律 403，包括 /health', async () => {
    const r = await req('/health', { headers: { Host: `evil.example.com:${new URL(base).port}` } })
    expect(r.status).toBe(403)
    expect(r.json.msg).toMatch(/Host 非法/)
  })

  it('攻击者即使带正确 Token 也被拒（Host 校验先于鉴权）', async () => {
    const r = await req('/api/v1/user/list', { token: 'secret-token', headers: { Host: 'evil.example.com' } })
    expect(r.status).toBe(403)
  })

  it('localhost / [::1] 形式被接受', async () => {
    for (const host of ['localhost:1', '127.0.0.1:1', '[::1]:1']) {
      const port = new URL(base).port
      const r = await req('/health', { headers: { Host: host.replace(/:1$/, `:${port}`) } })
      expect(r.status, `Host=${host} 应当允许`).toBe(200)
    }
  })
})

describe('CSRF：拦截浏览器发起的跨站状态变更', () => {
  it('<img src=...> 形式（Sec-Fetch-Site: cross-site）被拒', async () => {
    const r = await req('/api/v1/user/delete?user_id=p1', {
      headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' },
      token: 'secret-token'
    })
    expect(r.status).toBe(403)
    expect(r.json.msg).toMatch(/拒绝来自浏览器的跨站调用/)
    // 关键：环境必须还在
    expect(h.store.has('p1')).toBe(true)
  })

  it('跨站表单导航（Sec-Fetch-Mode: navigate）被拒', async () => {
    const r = await req('/api/v1/browser/start?user_id=p1', {
      headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site' },
      token: 'secret-token'
    })
    expect(r.status).toBe(403)
  })

  it('跨站 Origin 头被拒', async () => {
    const r = await req('/api/v1/user/delete?user_id=p1', {
      headers: { Origin: 'https://evil.example.com' },
      token: 'secret-token'
    })
    expect(r.status).toBe(403)
    expect(h.store.has('p1')).toBe(true)
  })

  it('跨站 Referer 被拒', async () => {
    const r = await req('/api/v1/user/delete?user_id=p1', {
      headers: { Referer: 'https://evil.example.com/page' },
      token: 'secret-token'
    })
    expect(r.status).toBe(403)
  })

  it('脚本客户端（不带 Sec-Fetch-*/Origin）照常工作 —— AdsPower 兼容不受影响', async () => {
    const started = await req('/api/v1/browser/start?user_id=p1&headless=1', { token: 'secret-token' })
    expect(started.json.code, started.json.msg).toBe(0)
    const stopped = await req('/api/v1/browser/stop?user_id=p1', { token: 'secret-token' })
    expect(stopped.json.code).toBe(0)
  })

  it('same-origin 的浏览器请求仍允许（自家界面调用）', async () => {
    const r = await req('/api/v1/browser/start?user_id=p1', {
      headers: { 'Sec-Fetch-Site': 'same-origin', Origin: base },
      token: 'secret-token'
    })
    expect(r.json.code, r.json.msg).toBe(0)
    await req('/api/v1/browser/stop?user_id=p1', { token: 'secret-token' })
  })

  it('只读接口不受 CSRF 拦截影响', async () => {
    const r = await req('/api/v1/user/list', {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      token: 'secret-token'
    })
    expect(r.json.code).toBe(0)
  })
})

describe('鉴权仍然严格', () => {
  it('无 Token 的 /api/v1/* 一律 401', async () => {
    expect((await req('/api/v1/user/list')).status).toBe(401)
    expect((await req('/api/v1/user/delete?user_id=p1')).status).toBe(401)
  })

  it('/health 不需要 Token（存活探针）', async () => {
    expect((await req('/health')).status).toBe(200)
  })
})
