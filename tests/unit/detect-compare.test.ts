import { describe, it, expect } from 'vitest'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { compareSignals, summarize, formatValue, candidateIp, type Snapshot } from '../../src/main/detect/compare'
import type { FingerprintConfig } from '@shared/fingerprint'

/**
 * 检测比对逻辑的单测。
 * 用一份「与配置完全自洽」的合成快照，验证规则表本身不会误报；
 * 再逐项注入偏差，验证每一项穿帮都能被抓出来。
 */

const fp: FingerprintConfig = generateFingerprint({
  seed: 'detect-unit',
  os: 'macOS',
  locale: 'en-US',
  timezone: 'Europe/Berlin',
  kernelVersion: '132.0.6834.110'
})

/** 模拟「注入层完全生效」时内核应该返回的信号 */
function snapshotOf(c: FingerprintConfig): Snapshot {
  return {
    webdriver: false,
    headed: true,
    userAgent: c.ua.ua,
    appVersion: c.ua.ua.replace(/^Mozilla\//, ''),
    platform: c.hardware.platform,
    languages: c.language.languages,
    language: c.language.languages[0],
    hardwareConcurrency: c.hardware.hardwareConcurrency,
    deviceMemory: c.hardware.deviceMemory,
    maxTouchPoints: c.hardware.maxTouchPoints,
    doNotTrack: c.privacy.dnt ? '1' : null,
    gpc: c.privacy.gpc,
    plugins: { length: 5, names: ['PDF Viewer'] },
    toStringNative: true,
    toStringNativeWindow: true,
    toStringNativeLayout: { clientHeight: true, offsetHeight: true, height: true },
    timezone: c.timezone.id,
    tzOffset: -c.timezone.offsetMinutes,
    intlLocale: c.language.intlLocale,
    screen: {
      width: c.screen.width,
      height: c.screen.height,
      availWidth: c.screen.availWidth,
      availHeight: c.screen.availHeight,
      colorDepth: c.screen.colorDepth,
      pixelDepth: c.screen.pixelDepth
    },
    dpr: c.screen.devicePixelRatio,
    window: {
      outerWidth: c.screen.windowWidth,
      outerHeight: c.screen.windowHeight,
      // 桌面 Chrome：宽度上 inner == outer，高度上差一条标签栏 + 地址栏
      innerWidth: c.screen.windowWidth,
      innerHeight: c.screen.windowHeight - 80
    },
    // 内核真实布局视口：注入层改不了，用来验证 inner 有没有和现实打架
    layout: {
      clientWidth: c.screen.windowWidth,
      clientHeight: c.screen.windowHeight - 80,
      offsetWidth: c.screen.windowWidth,
      offsetHeight: c.screen.windowHeight - 80,
      vvWidth: c.screen.windowWidth,
      vvHeight: c.screen.windowHeight - 80,
      // 铺满视口的 fixed 元素：引擎按真实视口排版，JS 改不掉
      fixedWidth: c.screen.windowWidth,
      fixedHeight: c.screen.windowHeight - 80
    },
    webgl: {
      supported: !c.webgl.blockWebgl,
      vendor: c.webgl.vendor,
      renderer: c.webgl.renderer,
      version: c.webgl.version,
      shadingVersion: c.webgl.shadingLanguageVersion,
      extCount: c.webgl.extensions.length,
      maxTexture: c.webgl.parameters.MAX_TEXTURE_SIZE,
      precision: { floatRange: '127/127', floatPrec: 23, intRange: '23/23' },
      pixels: { hash: 9091, first: [51, 102, 153, 255] }
    },
    webgpu: c.webgpu.enabled
      ? {
          supported: true,
          vendor: c.webgpu.vendor,
          architecture: c.webgpu.architecture,
          device: c.webgpu.device,
          description: c.webgpu.description,
          bothAgree: true,
          hasModernInfo: true
        }
      : { supported: false },
    canvas: { dataUrlLength: 12480, hash: 111, textWidth: 120.5 },
    audio: {
      hash: 222,
      sampleRate: 48000,
      channelCount: 1,
      analyserFloatHash: 333,
      analyserByteHash: 444,
      analyserTimeHash: 555
    },
    // ICE 候选：host 用配置里的假内网地址，srflx 用代理出口
    webrtc: {
      supported: true,
      candidates: [
        `candidate:1 1 udp 2122260223 ${c.webrtc.localIps[0]} 50000 typ host`,
        `candidate:2 1 udp 1685987071 ${c.webrtc.publicIp || '203.0.113.9'} 50001 typ srflx`
      ],
      sdpCandidates: [`candidate:1 1 udp 2122260223 ${c.webrtc.localIps[0]} 50000 typ host`]
    },
    fonts: {
      size: 12,
      arial: true,
      monospace: true,
      fake: false,
      ghostWidth: 360,
      monoWidth: 360,
      canvasFallbackMatches: true,
      domFallbackMatches: true,
      domWidth: 360
    },
    connection: {
      effectiveType: c.connection.effectiveType,
      rtt: c.connection.rtt,
      downlink: c.connection.downlink,
      saveData: c.connection.saveData,
      type: c.connection.type
    },
    battery: { charging: c.battery.charging, level: c.battery.level, chargingTime: -1, dischargingTime: Infinity },
    storage: { quota: c.storage.quota, usage: c.storage.usage },
    perfMemory: c.performance.memoryEnabled
      ? {
          jsHeapSizeLimit: c.performance.jsHeapSizeLimit,
          totalJSHeapSize: c.performance.totalJSHeapSize,
          usedJSHeapSize: c.performance.usedJSHeapSize
        }
      : null,
    uaData: c.clientHints.enabled
      ? {
          platform: c.clientHints.platform,
          architecture: c.clientHints.architecture,
          bitness: c.clientHints.bitness,
          uaFullVersion: c.clientHints.uaFullVersion,
          mobile: c.clientHints.mobile,
          brands: c.clientHints.brands
        }
      : null,
    // 自动化痕迹：注入层全部生效时应该一个破绽都没有
    stealth: {
      automationProps: [],
      chrome: { present: true, csi: 'function', loadTimes: 'function', app: 'object', runtime: 'object' },
      hidden: false,
      visibilityState: 'visible',
      hasFocus: true,
      voices: c.stealth.voices.length,
      voiceDefault: c.stealth.voices[0]?.name ?? null,
      paymentCanMakePayments: c.stealth.payment.canMakePayments,
      patchedFns: { total: 42, notNative: [] }
    },
    mediaQueries: {
      '(prefers-color-scheme: dark)': { matches: c.stealth.colorScheme === 'dark' },
      '(prefers-color-scheme: light)': { matches: c.stealth.colorScheme === 'light' },
      '(prefers-reduced-motion: reduce)': { matches: c.stealth.prefersReducedMotion },
      '(prefers-contrast: more)': { matches: c.stealth.prefersContrast === 'more' },
      '(forced-colors: active)': { matches: c.stealth.forcedColors === 'forced' },
      '(display-mode: browser)': { matches: c.stealth.displayMode === 'browser' },
      '(pointer: fine)': { matches: c.stealth.pointer === 'fine' },
      '(hover: hover)': { matches: c.stealth.hover === 'hover' },
      '(any-pointer: coarse)': { matches: c.stealth.pointer === 'coarse' },
      '(update: fast)': { matches: c.stealth.update === 'fast' },
      '(color-gamut: srgb)': { matches: true },
      '(scripting: enabled)': { matches: true }
    },
    mediaCodecs: {
      'video/mp4;codecs="avc1.42E01E"': c.stealth.codecs.h264,
      'video/webm;codecs="vp9"': c.stealth.codecs.vp9,
      'video/webm;codecs="av01.0.05M.08"': c.stealth.codecs.av1,
      'audio/mp4;codecs="mp4a.40.2"': c.stealth.codecs.aac,
      'audio/mpeg': c.stealth.codecs.mp3,
      'audio/webm;codecs=opus': c.stealth.codecs.opus
    },
    consoleGetterTrap: { triggered: !c.stealth.consoleHardening, looksNative: true }
  }
}

const byKey = (items: ReturnType<typeof compareSignals>, key: string) => items.find((i) => i.key === key)

describe('指纹检测比对', () => {
  it('完全自洽的快照：0 项不一致，满分', () => {
    const s = snapshotOf(fp)
    const items = compareSignals(fp, s, s)
    const sum = summarize(items)
    expect(items.filter((i) => i.status === 'mismatch').map((i) => `${i.key}: ${i.expected} != ${i.actual}`)).toEqual([])
    expect(sum.mismatch).toBe(0)
    expect(sum.score).toBe(100)
    expect(sum.ok).toBeGreaterThan(30)
  })

  it('UA 被改写 → 精确指出 ua.userAgent 不一致', () => {
    const s = { ...snapshotOf(fp), userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/99.0.4844.0' }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'ua.userAgent')!.status).toBe('mismatch')
    expect(byKey(items, 'ua.userAgent')!.actual).toContain('Chrome/99')
  })

  it('UA 与 Client Hints 主版本不一致 → 自洽检查抓到', () => {
    const s = snapshotOf(fp)
    const drifted = {
      ...s,
      uaData: { ...(s.uaData as Record<string, unknown>), uaFullVersion: '99.0.4844.0' }
    }
    const items = compareSignals(fp, drifted)
    expect(byKey(items, 'check.uaVsCh')!.status).toBe('mismatch')
    expect(byKey(items, 'ch.uaFullVersion')!.status).toBe('mismatch')
  })

  it('时区名对但偏移错 → Intl 与 Date 打脸被指出', () => {
    const s = { ...snapshotOf(fp), tzOffset: 120 }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'timezone.id')!.status).toBe('ok')
    expect(byKey(items, 'timezone.offset')!.status).toBe('mismatch')
  })

  it('webdriver=true 是硬伤', () => {
    const s = { ...snapshotOf(fp), webdriver: true }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.webdriver')!.status).toBe('mismatch')
  })

  it('噪声漂移：两次采样 canvas 不同 → 稳定性检查失败', () => {
    const s1 = snapshotOf(fp)
    const s2 = { ...s1, canvas: { ...(s1.canvas as Record<string, unknown>), hash: 999 } }
    const items = compareSignals(fp, s1, s2)
    expect(byKey(items, 'check.canvasStable')!.status).toBe('mismatch')
    expect(byKey(items, 'check.audioStable')!.status).toBe('ok')
  })

  it('探针缺项只记为未采集，不算不一致', () => {
    const items = compareSignals(fp, { webdriver: false })
    const sum = summarize(items)
    expect(byKey(items, 'check.webdriver')!.status).toBe('ok')
    expect(byKey(items, 'ua.userAgent')!.status).toBe('unknown')
    expect(byKey(items, 'ua.userAgent')!.actual).toBe('—')
    expect(sum.unknown).toBeGreaterThan(20)
  })

  it('数值容差：dpr 与窗口宽度不因取整误报', () => {
    const base = snapshotOf(fp)
    const win = base.window as Record<string, number>
    const s = {
      ...base,
      dpr: (base.dpr as number) + 0.004,
      window: { ...win, outerWidth: win.outerWidth + 2 }
    }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'screen.dpr')!.status).toBe('ok')
    expect(byKey(items, 'screen.windowWidth')!.status).toBe('ok')
  })

  it('关闭 WebGL 时按「不支持」判定，而不是比对厂商字符串', () => {
    const blocked = structuredClone(fp)
    blocked.webgl.blockWebgl = true
    const s = { ...snapshotOf(blocked), webgl: { supported: false } }
    const items = compareSignals(blocked, s)
    expect(byKey(items, 'check.blockWebgl')!.status).toBe('ok')
    expect(byKey(items, 'webgl.vendor')!.status).toBe('unknown')
  })

  it('窗口 getter 没伪装成 native code → 检查抓出来', () => {
    const s = { ...snapshotOf(fp), toStringNativeWindow: false }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.toStringNativeWindow')!.status).toBe('mismatch')
    expect(byKey(items, 'check.toStringNative')!.status).toBe('ok')
  })

  it('插件列表为空 → 自洽检查失败（真实 Chrome 不会是 0 个插件）', () => {
    const s = { ...snapshotOf(fp), plugins: { length: 0, names: [] } }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.plugins')!.status).toBe('mismatch')
  })

  it('改写过的 getter 没伪装成 native code → 源码会漏给网站，必须报出来', () => {
    const s = { ...snapshotOf(fp), toStringNativeWindow: false }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.toStringNativeWindow')!.status).toBe('mismatch')

    const partial = { ...snapshotOf(fp), toStringNativeLayout: { clientHeight: true, offsetHeight: false, height: true } }
    const items2 = compareSignals(fp, partial)
    const item = byKey(items2, 'check.toStringNativeLayout')!
    expect(item.status).toBe('mismatch')
    expect(item.actual).toContain('offsetHeight')
  })

  it('innerHeight 与引擎真实视口差 45px（注入层改写过）→ 视口自洽项失败', () => {
    const s = snapshotOf(fp)
    const layout = s.layout as Record<string, number>
    const shifted = { ...s, layout: { ...layout, fixedHeight: layout.fixedHeight - 45 } }
    const items = compareSignals(fp, shifted)
    expect(byKey(items, 'check.viewportVsLayout')!.status).toBe('mismatch')
    expect(byKey(items, 'check.viewportVsLayout')!.note).toContain('fixed')
  })

  it('视口自洽：innerHeight 与引擎真实视口一致（不撒谎方案的验收）', () => {
    const s = snapshotOf(fp)
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.viewportVsLayout')!.status).toBe('ok')
    expect(byKey(items, 'check.viewportWidthVsLayout')!.status).toBe('ok')
  })

  it('宽度方向差出 80px（不是滚动条）→ 宽度自洽项失败', () => {
    const s = snapshotOf(fp)
    const win = s.window as Record<string, number>
    const widened = { ...s, window: { ...win, innerWidth: win.innerWidth + 80 } }
    const items = compareSignals(fp, widened)
    expect(byKey(items, 'check.viewportWidthVsLayout')!.status).toBe('mismatch')
    // 高度那项没被动过，不该被牵连
    expect(byKey(items, 'check.viewportVsLayout')!.status).toBe('ok')
  })

  it('真实窗口没开成配置尺寸 → windowSizing 报出来（而不是悄悄对不上）', () => {
    const s = snapshotOf(fp)
    const win = s.window as Record<string, number>
    const off = { ...s, window: { ...win, outerHeight: win.outerHeight - 120 } }
    const items = compareSignals(fp, off)
    expect(byKey(items, 'check.windowSizing')!.status).toBe('mismatch')
    expect(byKey(items, 'check.windowSizing')!.expected).toContain(String(fp.screen.windowHeight))
  })

  it('窗口被显示器夹小 → windowSizing 记为 unknown 而不是 mismatch', () => {
    const s = snapshotOf(fp)
    const win = s.window as Record<string, number>
    const want = { width: fp.screen.windowWidth, height: fp.screen.windowHeight }
    const got = { width: want.width, height: 833 }
    const clamped = {
      ...s,
      window: { ...win, outerWidth: got.width, outerHeight: got.height },
      __windowBounds: { want, got }
    }
    const items = compareSignals(fp, clamped)
    const it1 = byKey(items, 'check.windowSizing')!
    expect(it1.status).toBe('unknown')
    expect(it1.note).toContain('显示器放不下')
  })

  it('窗口没被夹小但实测仍对不上 → 依然是 mismatch（不能拿夹取当借口）', () => {
    const s = snapshotOf(fp)
    const win = s.window as Record<string, number>
    const want = { width: fp.screen.windowWidth, height: fp.screen.windowHeight }
    const off = {
      ...s,
      window: { ...win, outerHeight: win.outerHeight - 120 },
      __windowBounds: { want, got: want }
    }
    const items = compareSignals(fp, off)
    expect(byKey(items, 'check.windowSizing')!.status).toBe('mismatch')
  })

  it('inner 与 outer 完全相等（headless 特征）→ 装饰高度项失败', () => {
    const s = snapshotOf(fp)
    const win = s.window as Record<string, number>
    const flat = { ...s, window: { ...win, innerHeight: win.outerHeight } }
    const items = compareSignals(fp, flat)
    expect(byKey(items, 'check.chromeHeight')!.status).toBe('mismatch')
  })

  it('探针没采到 layout 时跳过视口自洽项，而不是误报', () => {
    const s = snapshotOf(fp)
    const noLayout = { ...s, layout: { clientWidth: 100, clientHeight: 100 } }
    const items = compareSignals(fp, noLayout)
    expect(byKey(items, 'check.viewportVsLayout')).toBeUndefined()
    expect(byKey(items, 'check.viewportWidthVsLayout')).toBeUndefined()
  })

  it('窗口尺寸只改了一半 → inner/outer 自洽检查抓出来', () => {
    const base = snapshotOf(fp)
    const win = base.window as Record<string, number>
    // 真实窗口还是屏幕宽，但 outer 被改小了：inner 反而比 outer 大
    const s = { ...base, window: { ...win, innerWidth: win.outerWidth + 400 } }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.windowBox')!.status).toBe('mismatch')
    expect(byKey(items, 'check.windowBox')!.note).toContain('outer')
  })

  it('WebRTC：host 候选暴露真实内网 IP 时必须标红', () => {
    const s = snapshotOf(fp)
    const leaked = {
      ...s,
      webrtc: {
        supported: true,
        candidates: ['candidate:1 1 udp 2122260223 192.168.31.77 50000 typ host'],
        sdpCandidates: ['candidate:1 1 udp 2122260223 192.168.31.77 50000 typ host']
      }
    }
    const items = compareSignals(fp, leaked)
    expect(byKey(items, 'check.webrtcNoLocalLeak')!.status).toBe('mismatch')
    expect(byKey(items, 'check.webrtcNoLocalLeak')!.note).toContain('192.168.31.77')
    expect(byKey(items, 'check.webrtcHostIps')!.status).toBe('mismatch')
  })

  it('WebRTC：mDNS .local 候选同样算泄漏', () => {
    const s = snapshotOf(fp)
    const leaked = {
      ...s,
      webrtc: { supported: true, candidates: ['candidate:1 1 udp 1 a2b3c4.local 9 typ host'], sdpCandidates: [] }
    }
    const items = compareSignals(fp, leaked)
    expect(byKey(items, 'check.webrtcNoLocalLeak')!.status).toBe('mismatch')
  })

  it('WebRTC：disable 模式下仍收集到候选 = 没生效', () => {
    const off = structuredClone(fp)
    off.webrtc.mode = 'disable'
    const s = snapshotOf(off)
    const items = compareSignals(off, s)
    expect(byKey(items, 'check.webrtcDisabled')!.status).toBe('mismatch')
    const clean = { ...s, webrtc: { supported: true, candidates: [], sdpCandidates: [] } }
    expect(byKey(compareSignals(off, clean), 'check.webrtcDisabled')!.status).toBe('ok')
  })

  it('WebRTC：srflx 与代理出口不一致时指出 UDP 绕过了代理', () => {
    const s = snapshotOf(fp)
    const withIp = structuredClone(fp)
    withIp.webrtc.publicIp = '198.51.100.24'
    const items = compareSignals(withIp, s)
    expect(byKey(items, 'check.webrtcPublicIp')!.status).toBe('mismatch')
    expect(byKey(items, 'check.webrtcPublicIp')!.actual).toContain('203.0.113.9')
    // 对齐之后就通过
    const aligned = structuredClone(fp)
    aligned.webrtc.publicIp = '203.0.113.9'
    expect(byKey(compareSignals(aligned, snapshotOf(aligned)), 'check.webrtcPublicIp')!.status).toBe('ok')
  })

  it('WebRTC：删掉 RTCPeerConnection 本身就是特征', () => {
    const s = { ...snapshotOf(fp), webrtc: { supported: false, candidates: [], sdpCandidates: [] } }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.webrtcSupported')!.status).toBe('mismatch')
  })

  it('candidateIp 解析各种 candidate 行', () => {
    expect(candidateIp('candidate:1 1 udp 2122260223 192.168.1.5 9 typ host')).toBe('192.168.1.5')
    expect(candidateIp('candidate:2 1 udp 1685987071 203.0.113.9 40000 typ srflx raddr 0.0.0.0')).toBe('203.0.113.9')
    expect(candidateIp('a=candidate:1 1 udp 1 1.2.3.4 9 typ host')).toBeNull()
    expect(candidateIp('garbage')).toBeNull()
  })

  it('WebGPU：与 profile 期望逐项比对，只补一条读取路径会被抓', () => {
    const s = snapshotOf(fp)
    expect(byKey(compareSignals(fp, s), 'webgpu.vendor')!.status).toBe('ok')
    const wrong = { ...s, webgpu: { ...(s.webgpu as Record<string, unknown>), vendor: 'Intel Inc.', architecture: 'gen-12' } }
    const items = compareSignals(fp, wrong)
    expect(byKey(items, 'webgpu.vendor')!.status).toBe('mismatch')
    expect(byKey(items, 'webgpu.architecture')!.status).toBe('mismatch')
    // adapter.info 与 requestAdapterInfo() 给出不同答案 = 只补了一条
    const half = { ...s, webgpu: { ...(s.webgpu as Record<string, unknown>), bothAgree: false } }
    expect(byKey(compareSignals(fp, half), 'check.webgpuBothPaths')!.status).toBe('mismatch')
  })

  it('WebGL 改了但 WebGPU 没改 → GPU 厂商不同源被指出', () => {
    const s = snapshotOf(fp)
    const gpuOnly = { ...s, webgpu: { ...(s.webgpu as Record<string, unknown>), vendor: 'NVIDIA Corporation' } }
    const items = compareSignals(fp, gpuOnly)
    expect(byKey(items, 'check.gpuVendorCoherent')!.status).toBe('mismatch')
    expect(byKey(items, 'check.gpuVendorCoherent')!.actual).toContain('NVIDIA')
  })

  it('字体：canvas 与 DOM 回退不一致 = 只改了 measureText', () => {
    const s = snapshotOf(fp)
    const half = { ...s, fonts: { ...(s.fonts as Record<string, unknown>), domFallbackMatches: false } }
    const items = compareSignals(fp, half)
    expect(byKey(items, 'check.fontsCanvasFallback')!.status).toBe('ok')
    expect(byKey(items, 'check.fontsDomFallback')!.status).toBe('mismatch')
  })

  it('噪声漂移：readPixels / AnalyserNode 频谱两次不一致都要报出来', () => {
    const s1 = snapshotOf(fp)
    const s2 = {
      ...s1,
      webgl: { ...(s1.webgl as Record<string, unknown>), pixels: { hash: 777, first: [52, 102, 153, 255] } },
      audio: { ...(s1.audio as Record<string, unknown>), analyserFloatHash: 999 }
    }
    const items = compareSignals(fp, s1, s2)
    expect(byKey(items, 'check.glPixelsStable')!.status).toBe('mismatch')
    expect(byKey(items, 'check.audioAnalyserStable')!.status).toBe('mismatch')
    expect(byKey(items, 'check.audioStable')!.status).toBe('ok')
    expect(byKey(items, 'check.fontGhostStable')!.status).toBe('ok')
  })

  it('自动化痕迹：cdc_ 残留 / native 破绽 / 后台可见性都要被抓出来', () => {
    const s = snapshotOf(fp)
    const leaked = {
      ...s,
      stealth: {
        ...(s.stealth as Record<string, unknown>),
        automationProps: ['cdc_adoQpoasnfa76pfcZLmcfl_Array', '__selenium_unwrapped'],
        patchedFns: { total: 42, notNative: ['matchMedia', 'getVoices'] },
        visibilityState: 'hidden',
        hidden: true
      }
    }
    const items = compareSignals(fp, leaked)
    const a = byKey(items, 'check.automationProps')!
    expect(a.status).toBe('mismatch')
    expect(a.actual).toContain('cdc_')
    const n = byKey(items, 'check.nativeMarks')!
    expect(n.status).toBe('mismatch')
    expect(n.actual).toContain('matchMedia')
    expect(byKey(items, 'check.visibility')!.status).toBe('mismatch')
  })

  it('console getter 陷阱被触发 = 有调试器挂着，必须报不一致', () => {
    const s = { ...snapshotOf(fp), consoleGetterTrap: { triggered: true, looksNative: true } }
    const items = compareSignals(fp, s)
    expect(byKey(items, 'check.consoleTrap')!.status).toBe('mismatch')
    // 关掉加固时这一项不该判错，只是「未采集」
    const off = structuredClone(fp)
    off.stealth.consoleHardening = false
    expect(byKey(compareSignals(off, s), 'check.consoleTrap')!.status).toBe('unknown')
  })

  it('window.chrome 空壳 / 语音列表为空 / 支付能力不符', () => {
    const s = snapshotOf(fp)
    const hollow = {
      ...s,
      stealth: {
        ...(s.stealth as Record<string, unknown>),
        chrome: { present: true, csi: 'undefined', loadTimes: 'undefined', app: 'undefined', runtime: 'undefined' },
        voices: 0,
        voiceDefault: null,
        paymentCanMakePayments: !fp.stealth.payment.canMakePayments
      }
    }
    const items = compareSignals(fp, hollow)
    expect(byKey(items, 'check.chromeObject')!.status).toBe('mismatch')
    expect(byKey(items, 'check.voices')!.status).toBe('mismatch')
    expect(byKey(items, 'check.payment')!.status).toBe('mismatch')
  })

  it('matchMedia 与配置矛盾 / 缺 H.264 解码能力都能被指出', () => {
    const s = snapshotOf(fp)
    const mq = { ...(s.mediaQueries as Record<string, { matches: boolean }>) }
    mq['(pointer: fine)'] = { matches: false }
    mq['(display-mode: browser)'] = { matches: false }
    const codecs = { ...(s.mediaCodecs as Record<string, boolean>) }
    codecs['video/mp4;codecs="avc1.42E01E"'] = false
    const items = compareSignals(fp, { ...s, mediaQueries: mq, mediaCodecs: codecs })
    expect(byKey(items, 'check.mqPointer')!.status).toBe('mismatch')
    expect(byKey(items, 'check.mqDisplayMode')!.status).toBe('mismatch')
    expect(byKey(items, 'check.codec.h264')!.status).toBe('mismatch')
    expect(byKey(items, 'check.codec.vp9')!.status).toBe('ok')
  })

  it('formatValue 对缺省与对象稳定输出', () => {
    expect(formatValue(undefined)).toBe('—')
    expect(formatValue(null)).toBe('null')
    expect(formatValue(['a'])).toBe('["a"]')
    expect(formatValue(0)).toBe('0')
  })
})