import { DEFAULT_RETENTION } from '@shared/session'
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, profileUserDataDir, ensureDir } from '../../src/main/paths'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { resolveChromiumExecutable, detectKernelVersion } from '../../src/main/browser/executable'
import { launchProfile, stopProfile, stopAllProfiles } from '../../src/main/browser/launcher'
import { getSession } from '../../src/main/browser/registry'
import { awaitPageInjection } from '../../src/main/fingerprint/injector'
import type { Profile } from '@shared/types'

/**
 * 回归：CDP 的 UA-CH 覆盖必须同时改「线上 sec-ch-ua 请求头」和「JS 侧 navigator.userAgentData」，
 * 且两者一致。
 *
 * 曾经 formFactors 被塞进 CDP UserAgentMetadata，导致整个 setUserAgentOverride 被内核拒绝
 * （Invalid parameters），线上头退回内核默认值，而 JS 补丁已改成配置值 —— 制造「JS 与请求头不一致」穿帮。
 * 这个测试走真实注入路径（launchProfile → applyFingerprint），直接比对线上头与配置。
 */

let tmpDir = ''
let server: http.Server
let port = 0
const seen: { path: string; headers: http.IncomingHttpHeaders }[] = []

function makeProfile(fingerprint: ReturnType<typeof generateFingerprint>, id: string): Profile {
  const ts = Date.now()
  return {
    id,
    name: 'ch-wire-verify',
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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-chwire-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers })
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>ch</title><body>ch-wire</body>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await stopAllProfiles()
  await new Promise<void>((r) => server?.close(() => r()))
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 把配置里的 brands 序列化成 Chrome 线上 sec-ch-ua 头的形状："Brand";v="x", ... */
function headerBrands(brands: { brand: string; version: string }[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
}

describe('Client Hints 线上请求头一致性（真实注入路径）', () => {
  it('sec-ch-ua 等请求头等于配置值，且与 JS 侧 userAgentData 一致', async () => {
    const exe = resolveChromiumExecutable()
    const fp = generateFingerprint({
      seed: 'ch-wire-seed',
      os: 'macOS',
      locale: 'en-US',
      timezone: 'America/Los_Angeles',
      kernelVersion: detectKernelVersion(exe) ?? '154.0.8037.95'
    })
    const profile = makeProfile(fp, 'ch-wire-1')
    await launchProfile({ profile, headless: true })

    seen.length = 0
    const ctx = getSession(profile.id)!.context
    const page = await ctx.newPage()
    // 与生产路径一致：导航前等 CDP 覆盖落地，否则线上头退回内核默认值
    await awaitPageInjection(page)
    await page.goto(`http://127.0.0.1:${port}/doc`, { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(300)

    // 取文档请求（不是 favicon）
    const nav = seen.find((s) => s.path === '/doc')
    expect(nav, '没有捕获到文档请求').toBeTruthy()

    // 1) 线上 UA 头 == 配置 UA
    expect(nav!.headers['user-agent']).toBe(fp.ua.ua)

    // 2) 线上 sec-ch-ua == 配置 brands（关键：证明 CDP 覆盖在线上生效，而非退回内核默认）
    const wireSecChUa = nav!.headers['sec-ch-ua']
    expect(wireSecChUa, '线上 sec-ch-ua 缺失').toBeTruthy()
    expect(wireSecChUa).toBe(headerBrands(fp.clientHints.brands))

    // 3) 线上 sec-ch-ua-platform == 配置 platform
    expect(nav!.headers['sec-ch-ua-platform']).toBe(`"${fp.clientHints.platform}"`)
    expect(nav!.headers['sec-ch-ua-mobile']).toBe(fp.clientHints.mobile ? '?1' : '?0')

    // 4) JS 侧 userAgentData 与线上头一致（无「JS 改了、头没改」的穿帮）
    const js = (await page.evaluate(`(async () => {
      const uad = navigator.userAgentData;
      if (!uad) return null;
      const hev = await uad.getHighEntropyValues(['uaFullVersion','fullVersionList','platform','platformVersion','architecture','bitness','model','wow64']);
      return { brands: uad.brands, platform: hev.platform, uaFullVersion: hev.uaFullVersion, fvl: hev.fullVersionList, architecture: hev.architecture, bitness: hev.bitness, mobile: uad.mobile };
    })()`)) as {
      brands: { brand: string; version: string }[]
      platform: string
      uaFullVersion: string
      fvl: { brand: string; version: string }[]
      architecture: string
      bitness: string
      mobile: boolean
    } | null
    expect(js, 'navigator.userAgentData 不可用').toBeTruthy()
    expect(js!.brands).toEqual(fp.clientHints.brands)
    expect(js!.platform).toBe(fp.clientHints.platform)
    expect(js!.uaFullVersion).toBe(fp.clientHints.uaFullVersion)
    expect(js!.architecture).toBe(fp.clientHints.architecture)
    expect(js!.bitness).toBe(fp.clientHints.bitness)
    expect(js!.mobile).toBe(fp.clientHints.mobile)

    // 5) 线上头与 JS 的 brands 必须同源（这是本测试的核心断言）
    expect(headerBrands(js!.brands)).toBe(wireSecChUa)

    await page.close().catch(() => undefined)
    await stopProfile(profile.id)
  }, 120000)
})