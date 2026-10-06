import { DEFAULT_RETENTION } from '@shared/session'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { setDataDir, profileUserDataDir, ensureDir } from '../../src/main/paths'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { resolveChromiumExecutable, detectKernelVersion } from '../../src/main/browser/executable'
import { launchProfile, stopProfile, stopAllProfiles } from '../../src/main/browser/launcher'
import { allSessions, getSession } from '../../src/main/browser/registry'
import { startApiServer, type ApiContext, type ApiServerHandle } from '../../src/main/api/server'
import type { BrowserLaunchResult, ListResult, Profile, ProfileInput, StatusEvent } from '@shared/types'

/**
 * M7 验收：脚本通过 API 启动环境，再用返回的 CDP 端点接管同一个内核。
 *
 * 关键点是「接管的是同一个进程」：连上去读到的 UA 必须等于 profile 的指纹，
 * 否则说明 API 给的端点是假的（或者环境根本没带指纹启动）。
 */

let tmpDir = ''
let server: ApiServerHandle
let base = ''
const store = new Map<string, Profile>()

function makeProfile(id: string, name: string, fingerprint: Profile['fingerprint']): Profile {
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
    userDataDir: profileUserDataDir(id),
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
    fingerprint,
    proxy: null
  }
}

function call(path: string, method = 'GET', body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path)
    const headers: Record<string, string> = {}
    let payload: string | undefined
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
    }
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const ctx: ApiContext = {
  appVersion: 'live-test',
  listProfiles: (filter): ListResult<Profile> => {
    const q = (filter?.search ?? '').toLowerCase()
    const items = [...store.values()].filter((p) => !q || p.name.toLowerCase().includes(q))
    return { items, total: items.length }
  },
  getProfile: (id) => store.get(id) ?? null,
  createProfile: (input: ProfileInput) => {
    const p = makeProfile(
      `live-${store.size + 1}`,
      input.name,
      generateFingerprint({ seed: input.name, os: 'macOS', locale: 'en-US', timezone: 'Asia/Singapore' })
    )
    store.set(p.id, p)
    return p
  },
  updateProfile: (id, patch) => {
    const p = store.get(id)
    if (!p) return null
    if (patch.name !== undefined) p.name = patch.name
    store.set(id, p)
    return p
  },
  deleteProfile: (id) => {
    store.delete(id)
  },
  // 真实内核：API 的 start 直接走启动器，所以返回的端点是真 CDP
  startBrowser: (id, opts): Promise<BrowserLaunchResult> => {
    const profile = store.get(id)
    if (!profile) throw new Error(`profile not found: ${id}`)
    return launchProfile({ profile, headless: opts.headless ?? true })
  },
  stopBrowser: (id) => stopProfile(id),
  browserStatus: (id): StatusEvent | null => {
    const s = getSession(id)
    return s ? { profileId: s.profileId, status: s.status, pid: s.pid, wsEndpoint: s.wsEndpoint } : null
  },
  activeBrowsers: (): StatusEvent[] =>
    allSessions().map((s) => ({ profileId: s.profileId, status: s.status, pid: s.pid, wsEndpoint: s.wsEndpoint })),
  openUrls: async (id, urls) => {
    const s = getSession(id)
    if (!s) throw new Error(`环境未运行：${id}`)
    for (const url of urls) {
      const page = await s.context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => undefined)
    }
    return urls.length
  },
  checkIpByProfile: async () => ({
    ok: false,
    error: '离线测试环境不查出口',
    ip: null,
    country: null,
    region: null,
    city: null,
    isp: null,
    timezone: null,
    latencyMs: null
  }),
  getToken: () => ''
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-api-live-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  server = await startApiServer(ctx, { port: 0 })
  base = server.baseUrl
})

afterAll(async () => {
  await server?.stop()
  await stopAllProfiles()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('自动化 API（真实内核）', () => {
  it('API 建环境 -> API 启动 -> 用返回的 CDP 端点接管 -> 读到同一份指纹 -> API 关闭', async () => {
    const created = await call('/api/v1/user/create', 'POST', { browser_name: 'API 建的环境' })
    expect(created.code).toBe(0)
    const userId = created.data.user_id as string
    const profile = store.get(userId)!

    // 内核版本对齐，UA 才不会被内核自身差异影响断言
    const exe = resolveChromiumExecutable()
    const version = detectKernelVersion(exe)
    profile.fingerprint = generateFingerprint({
      seed: profile.fingerprint!.seed,
      os: 'macOS',
      locale: 'en-US',
      timezone: 'Asia/Singapore',
      ...(version ? { kernelVersion: version } : {})
    })

    const started = await call(`/api/v1/browser/start?user_id=${userId}&headless=1`)
    expect(started.msg, started.msg).toBe('success')
    const httpEndpoint = started.data.ws.puppeteer as string
    const wsEndpoint = started.data.ws.selenium as string
    expect(httpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//)

    const status = await call(`/api/v1/browser/status?user_id=${userId}`)
    expect(status.data.status).toBe('running')
    expect(status.data.pid).toBeGreaterThan(0)

    // 用 API 给的端点接管：这正是 Selenium / Playwright 脚本会做的事
    const browser = await chromium.connectOverCDP(httpEndpoint)
    try {
      const context = browser.contexts()[0]
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto('data:text/html,<title>api</title>', { waitUntil: 'load' })
      expect(await page.evaluate('navigator.userAgent')).toBe(profile.fingerprint!.ua.ua)
      expect(await page.evaluate('navigator.webdriver')).toBe(false)
      expect(await page.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('Asia/Singapore')
    } finally {
      await browser.close()
    }

    const active = await call('/api/v1/browser/active')
    expect(active.data.total).toBe(1)

    // urls 用逗号分隔，所以这里挑一个不含逗号的地址
    const opened = await call(`/api/v1/browser/open?user_id=${userId}&urls=about:blank`)
    expect(opened.data.opened).toBe(1)

    const stopped = await call(`/api/v1/browser/stop?user_id=${userId}`)
    expect(stopped.data.stopped).toBe(true)
    expect(getSession(userId)).toBeUndefined()

    const after = await call(`/api/v1/browser/status?user_id=${userId}`)
    expect(after.data.status).toBe('inactive')

    const list = await call('/api/v1/user/list')
    expect(list.data.total).toBe(1)
    expect(list.data.user_data[0].browser_name).toBe('API 建的环境')
  }, 120000)
})