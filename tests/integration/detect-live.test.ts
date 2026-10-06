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
import { PROBE_HTML, PROBE_FILENAME } from '../../src/main/detect/probe'
import { compareSignals, summarize, type Snapshot } from '../../src/main/detect/compare'
import type { Profile } from '@shared/types'

/**
 * M6 验收：内置探针页在真实内核里采到的信号，必须与 profile 期望逐项对上。
 * 这里用的 compareSignals 与界面展示的是同一个函数，所以测试通过 == 界面通过。
 */

let tmpDir = ''
let probeUrl = ''
let profile: Profile

function makeProfile(id: string, fingerprint: Profile['fingerprint']): Profile {
  const ts = Date.now()
  return {
    id,
    name: 'detect-live',
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-detect-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  const file = path.join(tmpDir, PROBE_FILENAME)
  fs.writeFileSync(file, PROBE_HTML, 'utf8')
  probeUrl = `${pathToFileURL(file).href}?headed=1`
})

afterAll(async () => {
  await stopAllProfiles()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function sample(): Promise<Snapshot> {
  const ctx = getSession(profile.id)!.context
  const page = await ctx.newPage()
  try {
    await page.goto(probeUrl, { waitUntil: 'load', timeout: 30000 })
    // UA / 时区 / locale 是 CDP 异步下发的，等覆盖落地再采样
    await page.waitForTimeout(400)
    return (await page.evaluate('window.__fpCollect()')) as Snapshot
  } finally {
    await page.close().catch(() => undefined)
  }
}

describe('指纹检测（真实内核 + 内置探针页）', () => {
  it('采集两次并与 profile 期望逐项比对', async () => {
    const exe = resolveChromiumExecutable()
    const fp = generateFingerprint({
      seed: 'detect-live-seed',
      os: 'macOS',
      locale: 'en-US',
      timezone: 'Asia/Tokyo',
      kernelVersion: detectKernelVersion(exe) ?? '132.0.6834.110'
    })
    profile = makeProfile('detect-live-1', fp)
    // 必须 headed：窗口尺寸是靠 --window-size + CDP setWindowBounds 把「真实窗口」
    // 开成配置值的，headless 没有真实窗口，这一环就验不到。
    await launchProfile({ profile, headless: false })

    const s1 = await sample()
    const s2 = await sample()

    // 探针本身要能跑完：关键分组都要有值
    expect(s1.userAgent).toBe(fp.ua.ua)
    expect(s1.timezone).toBe('Asia/Tokyo')
    expect(typeof s1.webgl).toBe('object')
    // 真实布局视口必须采到：这是判断「注入层有没有和现实打架」的依据
    const layout = s1.layout as Record<string, number>
    expect(typeof layout?.clientHeight).toBe('number')
    expect(layout.clientHeight).toBeGreaterThan(0)

    const items = compareSignals(fp, s1, s2)
    const sum = summarize(items)
    const bad = items
      .filter((i) => i.status === 'mismatch')
      .map((i) => `${i.key} 期望=${i.expected} 实测=${i.actual}`)
    // eslint-disable-next-line no-console
    console.log(
      '[detect] 窗口配置=',
      `${fp.screen.windowWidth}x${fp.screen.windowHeight}`,
      'window=',
      JSON.stringify(s1.window),
      'layout=',
      JSON.stringify(s1.layout)
    )
    // eslint-disable-next-line no-console
    console.log('[detect] score=', sum.score, 'ok=', sum.ok, 'unknown=', sum.unknown, 'mismatch=', bad)

    for (const key of [
      'ua.userAgent',
      'ua.appVersion',
      'ua.platform',
      'timezone.id',
      'timezone.offset',
      'language.languages',
      'language.intlLocale',
      'screen.width',
      'screen.height',
      'screen.colorDepth',
      'screen.windowWidth',
      'webgl.vendor',
      'webgl.renderer',
      'webgl.extensions',
      'hardware.concurrency',
      'hardware.memory',
      'hardware.touchPoints',
      'ch.platform',
      'ch.architecture',
      'ch.uaFullVersion',
      'check.webdriver',
      'check.uaVsCh',
      'check.plugins',
      'check.windowBox',
      'check.windowSizing',
      'check.chromeHeight',
      'check.toStringNativeWindow',
      'check.toStringNativeLayout',
      'check.viewportVsLayout',
      'check.viewportWidthVsLayout',
      'check.canvasStable',
      'check.audioStable',
      'webgpu.vendor',
      'webgpu.architecture',
      'check.webgpuBothPaths',
      'check.gpuVendorCoherent',
      'check.fontsCanvasFallback',
      'check.fontsDomFallback',
      'check.glPixelsStable',
      'check.audioAnalyserStable',
      'check.fontGhostStable',
      'check.webrtcSupported',
      'check.automationProps',
      'check.nativeMarks',
      'check.visibility',
      'check.chromeObject',
      'check.consoleTrap',
      'check.voices',
      'check.payment',
      'check.mqPointer',
      'check.mqHover',
      'check.mqDisplayMode',
      'check.mqColorScheme',
      'check.codec.h264',
      'check.codec.aac',
      'check.codec.opus'
    ]) {
      const item = items.find((i) => i.key === key)
      expect(item, `缺少比对项 ${key}`).toBeTruthy()
      expect(item!.status, `${key}: 期望=${item!.expected} 实测=${item!.actual}`).toBe('ok')
    }

    expect(sum.score).toBeGreaterThanOrEqual(90)

    await stopProfile(profile.id)
  }, 120000)
})