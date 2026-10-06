import { DEFAULT_RETENTION } from '@shared/session'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setDataDir, profileUserDataDir, ensureDir } from '../../src/main/paths'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { resolveChromiumExecutable, detectKernelVersion } from '../../src/main/browser/executable'
import { launchProfile, stopProfile, stopAllProfiles } from '../../src/main/browser/launcher'
import { getSession } from '../../src/main/browser/registry'
import type { Profile } from '@shared/types'

/**
 * 端到端验证：真实 Chromium 内核 + CDP 注入，读取页面内实际信号。
 * 这是 M3 指纹引擎的验收标准。不依赖 SQLite（Electron ABI 原生模块）。
 */

let tmpDir = ''
let firstRunCanvasHash = 0
let testProfile: Profile

function makeProfile(fingerprint: ReturnType<typeof generateFingerprint>, id: string): Profile {
  const ts = Date.now()
  return {
    id,
    name: 'live-verify',
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

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-live-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  // file:// 属于安全上下文，navigator.userAgentData 才会暴露
  fs.writeFileSync(
    path.join(tmpDir, 'probe.html'),
    '<!doctype html><meta charset="utf-8"><title>probe</title><body>fpb probe</body>'
  )
})

function probeUrl(): string {
  return pathToFileURL(path.join(tmpDir, 'probe.html')).href
}

afterAll(async () => {
  await stopAllProfiles()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

interface Signals {
  webdriver: boolean
  userAgent: string
  platform: string
  languages: string[]
  hardwareConcurrency: number
  deviceMemory: number
  maxTouchPoints: number
  pluginsLength: number
  timezone: string
  tzOffset: number
  locale: string
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number; dpr: number }
  glInfo: { vendor: string; renderer: string; maxTexture: number; extCount: number } | null
  canvasHash: number
  dataUrlLength: number
  audioHash: number
  connection: string
  hasPerformanceMemory: boolean
  patchedToStringNative: boolean
  uaData: { platformVersion: string; architecture: string; fullVersionList: { brand: string; version: string }[] } | null
}

const PROBE = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 220; canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top'; ctx.font = '16px Arial';
  ctx.fillStyle = '#f60'; ctx.fillRect(20, 10, 120, 30);
  ctx.fillText('fingerprint-测试', 22, 12);
  const dataUrlLength = canvas.toDataURL().length;
  const px = ctx.getImageData(0, 0, 40, 20).data;
  const canvasHash = Array.from(px.slice(0, 64)).reduce((a, b) => (a * 31 + b) >>> 0, 7);

  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const glInfo = dbg ? {
    vendor: String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)),
    renderer: String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    extCount: (gl.getSupportedExtensions() || []).length
  } : null;

  const audioCtx = new OfflineAudioContext(1, 32, 48000);
  const osc = audioCtx.createOscillator();
  osc.connect(audioCtx.destination); osc.start(0);

  return audioCtx.startRendering().then((buf) => {
    const samples = buf.getChannelData(0);
    const audioHash = Array.from(samples.slice(0, 64)).reduce((a, b) => (a + Math.abs(b) * 1e6) >>> 0, 11);
    const uaData = navigator.userAgentData
      ? navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'fullVersionList'])
      : null;
    return Promise.resolve(uaData).then((ua) => ({
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: Array.from(navigator.languages),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      pluginsLength: navigator.plugins.length,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffset: new Date().getTimezoneOffset(),
      locale: navigator.language,
      screen: {
        width: window.screen.width, height: window.screen.height,
        availWidth: window.screen.availWidth, availHeight: window.screen.availHeight,
        colorDepth: window.screen.colorDepth, dpr: window.devicePixelRatio
      },
      glInfo, canvasHash, dataUrlLength, audioHash,
      connection: (navigator.connection || {}).effectiveType,
      hasPerformanceMemory: typeof (performance.memory || {}).jsHeapSizeLimit === 'number',
      patchedToStringNative: CanvasRenderingContext2D.prototype.getImageData.toString().includes('[native code]'),
      uaData: ua ? { platformVersion: ua.platformVersion, architecture: ua.architecture, fullVersionList: ua.fullVersionList } : null
    }));
  });
})()`

describe('真实内核指纹注入', () => {
  it('启动内核并让页面内的指纹信号等于 profile 配置', async () => {
    const exe = resolveChromiumExecutable()
    expect(fs.existsSync(exe)).toBe(true)
    const kernelVersion = detectKernelVersion(exe) ?? '153.0.8010.12'

    const fp = generateFingerprint({
      seed: 'live-verify-seed',
      os: 'macOS',
      locale: 'en-US',
      timezone: 'Europe/Berlin',
      kernelVersion
    })
    testProfile = makeProfile(fp, 'live-verify-1')
    const profile = testProfile

    const result = await launchProfile({ profile, headless: true })
    expect(result.pid).toBeGreaterThan(0)
    expect(result.wsEndpoint).toContain('ws://')

    const context = getSession(profile.id)!.context
    const page = await context.newPage()
    await page.goto(probeUrl())
    await page.waitForTimeout(400)
    const s = (await page.evaluate(PROBE)) as Signals
    // --- navigator ---
    expect(s.webdriver).toBe(false)
    expect(s.userAgent).toBe(fp.ua.ua)
    expect(s.platform).toBe(fp.hardware.platform)
    expect(s.hardwareConcurrency).toBe(fp.hardware.hardwareConcurrency)
    expect(s.deviceMemory).toBe(fp.hardware.deviceMemory)
    expect(s.maxTouchPoints).toBe(fp.hardware.maxTouchPoints)
    expect(s.languages).toEqual(fp.language.languages)
    // chrome_default 模式不改写 plugins，必须保持真实 Chrome 的非空插件列表
    // （plugins.length === 0 是常见的自动化特征）
    expect(s.pluginsLength).toBeGreaterThan(0)

    // --- 时区 / locale ---
    expect(s.timezone).toBe(fp.timezone.id)
    expect(s.tzOffset).toBe(-fp.timezone.offsetMinutes)
    expect(s.locale).toBe(fp.language.intlLocale)

    // --- 屏幕 ---
    expect(s.screen.width).toBe(fp.screen.width)
    expect(s.screen.height).toBe(fp.screen.height)
    expect(s.screen.availHeight).toBe(fp.screen.availHeight)
    expect(s.screen.colorDepth).toBe(fp.screen.colorDepth)

    // --- WebGL ---
    expect(s.glInfo!.vendor).toBe(fp.webgl.vendor)
    expect(s.glInfo!.renderer).toBe(fp.webgl.renderer)
    expect(s.glInfo!.maxTexture).toBe(fp.webgl.parameters.MAX_TEXTURE_SIZE)
    expect(s.glInfo!.extCount).toBe(fp.webgl.extensions.length)

    // --- Canvas / Audio 噪声生效 ---
    expect(s.canvasHash).toBeGreaterThan(0)
    expect(s.dataUrlLength).toBeGreaterThan(1000)
    expect(s.audioHash).toBeGreaterThan(0)

    // --- 其它信号 ---
    expect(s.connection).toBe(fp.connection.effectiveType)
    expect(s.hasPerformanceMemory).toBe(true)
    expect(s.patchedToStringNative).toBe(true)

    // --- Client Hints 与 UA 自洽 ---
    expect(s.uaData).toBeTruthy()
    expect(s.uaData!.architecture).toBe(fp.clientHints.architecture)
    const chromeBrand = (s.uaData!.fullVersionList || []).find((b: { brand: string }) => b.brand === 'Google Chrome')
    expect(chromeBrand?.version).toBe(fp.clientHints.uaFullVersion)

    firstRunCanvasHash = s.canvasHash
    await stopProfile(profile.id)
  }, 90000)

  it('同一 profile 重启后指纹信号完全一致（可复现，多开不漂移）', async () => {
    const profile = testProfile
    expect(profile.fingerprint).toBeTruthy()
    await launchProfile({ profile, headless: true })
    const context = getSession(profile.id)!.context
    const page = await context.newPage()
    await page.goto(probeUrl())
    await page.waitForTimeout(300)
    const s = (await page.evaluate(PROBE)) as Signals
    const fp = profile.fingerprint!
    expect(s.timezone).toBe(fp.timezone.id)
    expect(s.userAgent).toBe(fp.ua.ua)
    expect(s.glInfo!.renderer).toBe(fp.webgl.renderer)
    // canvas 噪声由 seed 决定：跨进程重启必须完全一致
    expect(s.canvasHash).toBe(firstRunCanvasHash)
    await stopProfile(profile.id)
  }, 90000)
})
