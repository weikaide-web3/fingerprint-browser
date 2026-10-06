import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { setDataDir, profileUserDataDir, ensureDir } from '../../src/main/paths'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { launchProfile, stopProfile, stopAllProfiles } from '../../src/main/browser/launcher'
import { getSession } from '../../src/main/browser/registry'
import {
  normalizeCookie,
  parseCookies,
  parseNetscape,
  parseStorageState,
  toNetscape,
  toStorageState
} from '../../src/main/session/cookies'
import { dirSize } from '../../src/main/session/disk'
import type { CookieRecord } from '@shared/session'
import { DEFAULT_RETENTION } from '@shared/session'
import type { Profile } from '@shared/types'

/**
 * M5 验收：真实内核里的登录态能不能被完整搬走。
 * 走的是与界面完全相同的路径 —— CDP 读写 cookie / localStorage，再经格式转换器往返。
 * 不依赖 SQLite（原生模块按 Electron ABI 编译，纯 Node 测试链加载不了）。
 */

let tmpDir = ''
let origin: { port: number; server: http.Server; url: string }

function makeProfile(id: string): Profile {
  const ts = Date.now()
  const fingerprint = generateFingerprint({ seed: `session-${id}`, os: 'macOS', locale: 'en-US', timezone: 'Asia/Shanghai' })
  return {
    id,
    name: `session-${id}`,
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

function startOrigin(): Promise<{ port: number; server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>fpb session probe</title><body>ok</body>')
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, server, url: `http://127.0.0.1:${port}/` })
    })
  })
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-session-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  origin = await startOrigin()
})

afterAll(async () => {
  await stopAllProfiles()
  origin?.server.close()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('登录态导出 / 导入（真实内核）', () => {
  let exportedState = ''
  let exportedCount = 0

  it('环境 A：内核写入 cookie + localStorage，导出两种格式并完整往返', async () => {
    const profile = makeProfile('session-a')
    await launchProfile({ profile, headless: true })
    const ctx = getSession(profile.id)!.context

    await ctx.addCookies([
      { name: 'sid', value: 'A-SECRET', domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 3600 },
      { name: 'theme', value: 'dark', domain: '127.0.0.1', path: '/', httpOnly: false, secure: false, sameSite: 'Lax', expires: -1 }
    ])
    const page = await ctx.newPage()
    await page.goto(origin.url, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      localStorage.setItem('cart', JSON.stringify({ items: 3 }))
      sessionStorage.setItem('tmp', 'nope')
    })
    const storage = await page.evaluate(() => {
      const items: { name: string; value: string }[] = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i)
        if (k !== null) items.push({ name: k, value: String(localStorage.getItem(k)) })
      }
      return items
    })
    await page.close()

    const live = (await ctx.cookies()).map((c) => normalizeCookie(c))
    expect(live.map((c) => c.name).sort()).toEqual(['sid', 'theme'])

    const netscape = toNetscape(live)
    exportedState = toStorageState({ cookies: live, origins: [{ origin: origin.url, localStorage: storage }] })
    exportedCount = live.length

    // 格式往返必须无损：httpOnly 标记、会话级过期、localStorage 都要回来
    const backNetscape = parseCookies(netscape, 'auto')
    expect(backNetscape.format).toBe('netscape')
    expect(backNetscape.issues).toEqual([])
    expect(backNetscape.bundle.cookies).toHaveLength(exportedCount)
    const sid = backNetscape.bundle.cookies.find((c) => c.name === 'sid')!
    expect(sid.value).toBe('A-SECRET')
    expect(sid.httpOnly).toBe(true)
    const theme = backNetscape.bundle.cookies.find((c) => c.name === 'theme')!
    expect(theme.expires).toBe(-1)

    const backState = parseStorageState(exportedState)
    expect(backState.bundle.origins[0].localStorage).toEqual([{ name: 'cart', value: '{"items":3}' }])

    await stopProfile(profile.id)
  }, 90000)

  it('环境 B：导入后内核实际能读到同一份登录态（含 localStorage）', async () => {
    const profile = makeProfile('session-b')
    await launchProfile({ profile, headless: true })
    const ctx = getSession(profile.id)!.context

    const { bundle } = parseCookies(exportedState, 'auto')
    expect(bundle.cookies.length).toBe(exportedCount)
    await ctx.addCookies(
      bundle.cookies.map((c: CookieRecord) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite
      }))
    )
    const page = await ctx.newPage()
    await page.goto(origin.url, { waitUntil: 'domcontentloaded' })
    await page.evaluate((entries: { name: string; value: string }[]) => {
      for (const e of entries) localStorage.setItem(e.name, e.value)
    }, bundle.origins[0].localStorage)
    const cart = (await page.evaluate('localStorage.getItem("cart")')) as string | null
    // document 不在 node 的 lib 里，用字符串表达式在页面上下文求值
    const visibleCookie = (await page.evaluate('document.cookie')) as string
    await page.close()

    expect(cart).toBe('{"items":3}')
    // httpOnly 的 sid 不会出现在 document.cookie 里（这是正确行为）；theme 必须可见
    expect(visibleCookie).toContain('theme=dark')
    const live = await ctx.cookies(origin.url)
    expect(live.map((c) => c.name).sort()).toEqual(['sid', 'theme'])
    expect(live.find((c) => c.name === 'sid')!.value).toBe('A-SECRET')

    await stopProfile(profile.id)
  }, 90000)

  it('Netscape 文本同样能导入到另一个环境', async () => {
    const profile = makeProfile('session-d')
    await launchProfile({ profile, headless: true })
    const ctx = getSession(profile.id)!.context
    const text = toNetscape([
      {
        name: 'sid',
        value: 'A-SECRET',
        domain: '127.0.0.1',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax'
      }
    ])
    const { cookies, issues } = parseNetscape(text)
    expect(issues).toEqual([])
    await ctx.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })))
    const live = await ctx.cookies(origin.url)
    expect(live.map((c) => c.name)).toEqual(['sid'])
    await stopProfile(profile.id)
  }, 90000)

  it('清空登录态后内核确实读不到 cookie', async () => {
    const profile = makeProfile('session-c')
    await launchProfile({ profile, headless: true })
    const ctx = getSession(profile.id)!.context
    await ctx.addCookies([{ name: 'tmp', value: '1', domain: '127.0.0.1', path: '/' }])
    expect((await ctx.cookies()).length).toBeGreaterThan(0)
    await ctx.clearCookies()
    expect(await ctx.cookies()).toHaveLength(0)
    await stopProfile(profile.id)
  }, 90000)

  it('隔离目录体积统计可用（清理策略依赖它）', () => {
    const dir = profileUserDataDir('session-a')
    expect(fs.existsSync(dir)).toBe(true)
    expect(dirSize(dir)).toBeGreaterThan(0)
    expect(dirSize(path.join(tmpDir, 'no-such-dir'))).toBe(0)
  })
})