import type { FingerprintConfig } from '@shared/fingerprint'
import type { DetectItem, DetectStatus } from '@shared/detect'

/**
 * 把「profile 里配置的期望值」和「内核里实测到的值」逐项对齐。
 *
 * 纯函数：不碰内核，因此可以用一份合成快照做完整单测；
 * 真实信号采集在 services/detect.ts，两边共用同一张规则表，
 * 保证「界面上看到的比对」与「集成测试里断言的东西」是同一套逻辑。
 */

export type Snapshot = Record<string, unknown>

function get(s: Snapshot, path: string): unknown {
  let cur: unknown = s
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function formatValue(v: unknown): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function same(a: unknown, b: unknown, tolerance?: number): boolean {
  if (typeof a === 'number' && typeof b === 'number' && tolerance !== undefined) return Math.abs(a - b) <= tolerance
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return String(a) === String(b)
}

const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|::|fe80:)/i

/**
 * 从 ICE candidate 行里取地址。
 * 格式：candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
 */
export function candidateIp(line: string): string | null {
  const m = /^candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+\w+/.exec(line.trim())
  return m ? m[1] : null
}

interface Rule {
  group: string
  key: string
  label: string
  /** 从 profile 配置推导期望值；返回 undefined 表示这一项没有可比对的期望 */
  expected: (fp: FingerprintConfig) => unknown
  /** 实测快照里的取值路径 */
  actual: string
  tolerance?: number
  note?: string
}

const UA = 'UA / Client Hints'
const LOCALE = '语言 / 时区'
const SCREEN = '屏幕 / 窗口'
const GL = 'WebGL'
const HW = '硬件'
const PRIVACY = '隐私信号'
const NET = '网络 / 存储'

const RULES: Rule[] = [
  { group: UA, key: 'ua.userAgent', label: 'navigator.userAgent', expected: (fp) => fp.ua.ua, actual: 'userAgent' },
  { group: UA, key: 'ua.appVersion', label: 'navigator.appVersion', expected: (fp) => fp.ua.ua.replace(/^Mozilla\//, ''), actual: 'appVersion' },
  { group: UA, key: 'ua.platform', label: 'navigator.platform', expected: (fp) => fp.hardware.platform, actual: 'platform' },
  { group: UA, key: 'ch.platform', label: 'CH platform', expected: (fp) => (fp.clientHints.enabled ? fp.clientHints.platform : undefined), actual: 'uaData.platform' },
  { group: UA, key: 'ch.architecture', label: 'CH architecture', expected: (fp) => (fp.clientHints.enabled ? fp.clientHints.architecture : undefined), actual: 'uaData.architecture' },
  { group: UA, key: 'ch.bitness', label: 'CH bitness', expected: (fp) => (fp.clientHints.enabled ? fp.clientHints.bitness : undefined), actual: 'uaData.bitness' },
  { group: UA, key: 'ch.uaFullVersion', label: 'CH uaFullVersion', expected: (fp) => (fp.clientHints.enabled ? fp.clientHints.uaFullVersion : undefined), actual: 'uaData.uaFullVersion' },
  { group: UA, key: 'ch.mobile', label: 'CH mobile', expected: (fp) => (fp.clientHints.enabled ? fp.clientHints.mobile : undefined), actual: 'uaData.mobile' },
  { group: UA, key: 'ch.brands', label: 'CH brands', expected: (fp) => (fp.clientHints.enabled ? fp.clientHints.brands : undefined), actual: 'uaData.brands' },

  { group: LOCALE, key: 'timezone.id', label: 'Intl timeZone', expected: (fp) => fp.timezone.id, actual: 'timezone' },
  {
    group: LOCALE,
    key: 'timezone.offset',
    label: 'getTimezoneOffset',
    // 配置里的 offsetMinutes 沿用 getTimezoneOffset 的符号约定（UTC+8 => -480）
    expected: (fp) => -fp.timezone.offsetMinutes,
    actual: 'tzOffset',
    note: '时区名与偏移必须同时匹配，否则 Intl 与 Date 互相打脸'
  },
  { group: LOCALE, key: 'language.languages', label: 'navigator.languages', expected: (fp) => fp.language.languages, actual: 'languages' },
  { group: LOCALE, key: 'language.language', label: 'navigator.language', expected: (fp) => fp.language.languages[0], actual: 'language' },
  { group: LOCALE, key: 'language.intlLocale', label: 'Intl locale', expected: (fp) => fp.language.intlLocale, actual: 'intlLocale' },

  { group: SCREEN, key: 'screen.width', label: 'screen.width', expected: (fp) => fp.screen.width, actual: 'screen.width' },
  { group: SCREEN, key: 'screen.height', label: 'screen.height', expected: (fp) => fp.screen.height, actual: 'screen.height' },
  { group: SCREEN, key: 'screen.availWidth', label: 'screen.availWidth', expected: (fp) => fp.screen.availWidth, actual: 'screen.availWidth' },
  { group: SCREEN, key: 'screen.availHeight', label: 'screen.availHeight', expected: (fp) => fp.screen.availHeight, actual: 'screen.availHeight' },
  { group: SCREEN, key: 'screen.colorDepth', label: 'screen.colorDepth', expected: (fp) => fp.screen.colorDepth, actual: 'screen.colorDepth' },
  { group: SCREEN, key: 'screen.pixelDepth', label: 'screen.pixelDepth', expected: (fp) => fp.screen.pixelDepth, actual: 'screen.pixelDepth' },
  { group: SCREEN, key: 'screen.dpr', label: 'devicePixelRatio', expected: (fp) => fp.screen.devicePixelRatio, actual: 'dpr', tolerance: 0.01 },
  {
    group: SCREEN,
    key: 'screen.windowWidth',
    label: 'window.outerWidth',
    expected: (fp) => fp.screen.windowWidth,
    actual: 'window.outerWidth',
    tolerance: 4,
    note: '窗口宽度受窗口管理器影响，允许 ±4px'
  }
]

const MORE_RULES: Rule[] = [
  { group: GL, key: 'webgl.vendor', label: 'UNMASKED_VENDOR', expected: (fp) => (fp.webgl.blockWebgl ? undefined : fp.webgl.vendor), actual: 'webgl.vendor' },
  { group: GL, key: 'webgl.renderer', label: 'UNMASKED_RENDERER', expected: (fp) => (fp.webgl.blockWebgl ? undefined : fp.webgl.renderer), actual: 'webgl.renderer' },
  { group: GL, key: 'webgl.version', label: 'gl.VERSION', expected: (fp) => (fp.webgl.blockWebgl ? undefined : fp.webgl.version), actual: 'webgl.version' },
  { group: GL, key: 'webgl.shadingVersion', label: 'SHADING_LANGUAGE_VERSION', expected: (fp) => (fp.webgl.blockWebgl ? undefined : fp.webgl.shadingLanguageVersion), actual: 'webgl.shadingVersion' },
  { group: GL, key: 'webgl.extensions', label: '扩展数量', expected: (fp) => (fp.webgl.blockWebgl ? undefined : fp.webgl.extensions.length), actual: 'webgl.extCount' },
  {
    group: GL,
    key: 'webgl.MAX_TEXTURE_SIZE',
    label: 'MAX_TEXTURE_SIZE',
    expected: (fp) => (fp.webgl.blockWebgl ? undefined : fp.webgl.parameters.MAX_TEXTURE_SIZE),
    actual: 'webgl.maxTexture'
  },

  // WebGPU：必须与 WebGL 的 vendor/renderer 同源，否则两个 API 互相打脸
  { group: GL, key: 'webgpu.vendor', label: 'GPUAdapter vendor', expected: (fp) => (fp.webgpu.enabled ? fp.webgpu.vendor : undefined), actual: 'webgpu.vendor' },
  { group: GL, key: 'webgpu.architecture', label: 'GPUAdapter architecture', expected: (fp) => (fp.webgpu.enabled ? fp.webgpu.architecture : undefined), actual: 'webgpu.architecture' },
  { group: GL, key: 'webgpu.device', label: 'GPUAdapter device', expected: (fp) => (fp.webgpu.enabled ? fp.webgpu.device : undefined), actual: 'webgpu.device' },
  { group: GL, key: 'webgpu.description', label: 'GPUAdapter description', expected: (fp) => (fp.webgpu.enabled ? fp.webgpu.description : undefined), actual: 'webgpu.description' },

  { group: HW, key: 'hardware.concurrency', label: 'hardwareConcurrency', expected: (fp) => fp.hardware.hardwareConcurrency, actual: 'hardwareConcurrency' },
  { group: HW, key: 'hardware.memory', label: 'deviceMemory', expected: (fp) => fp.hardware.deviceMemory, actual: 'deviceMemory' },
  { group: HW, key: 'hardware.touchPoints', label: 'maxTouchPoints', expected: (fp) => fp.hardware.maxTouchPoints, actual: 'maxTouchPoints' },

  { group: PRIVACY, key: 'privacy.dnt', label: 'navigator.doNotTrack', expected: (fp) => (fp.privacy.dnt ? '1' : null), actual: 'doNotTrack' },
  { group: PRIVACY, key: 'privacy.gpc', label: 'globalPrivacyControl', expected: (fp) => fp.privacy.gpc, actual: 'gpc' },

  { group: NET, key: 'connection.effectiveType', label: 'connection.effectiveType', expected: (fp) => (fp.connection.enabled ? fp.connection.effectiveType : undefined), actual: 'connection.effectiveType' },
  { group: NET, key: 'connection.rtt', label: 'connection.rtt', expected: (fp) => (fp.connection.enabled ? fp.connection.rtt : undefined), actual: 'connection.rtt', tolerance: 50 },
  { group: NET, key: 'connection.downlink', label: 'connection.downlink', expected: (fp) => (fp.connection.enabled ? fp.connection.downlink : undefined), actual: 'connection.downlink', tolerance: 0.5 },
  { group: NET, key: 'connection.saveData', label: 'connection.saveData', expected: (fp) => (fp.connection.enabled ? fp.connection.saveData : undefined), actual: 'connection.saveData' },
  { group: NET, key: 'storage.quota', label: 'storage.estimate.quota', expected: (fp) => fp.storage.quota || undefined, actual: 'storage.quota' },
  { group: NET, key: 'battery.level', label: 'battery.level', expected: (fp) => (fp.battery.enabled ? fp.battery.level : undefined), actual: 'battery.level' },
  { group: NET, key: 'battery.charging', label: 'battery.charging', expected: (fp) => (fp.battery.enabled ? fp.battery.charging : undefined), actual: 'battery.charging' },
  { group: NET, key: 'perf.memory', label: 'performance.memory.jsHeapSizeLimit', expected: (fp) => (fp.performance.memoryEnabled ? fp.performance.jsHeapSizeLimit : undefined), actual: 'perfMemory.jsHeapSizeLimit' }
]

const ALL_RULES: Rule[] = [...RULES, ...MORE_RULES]

function item(
  group: string,
  key: string,
  label: string,
  expected: string,
  actual: string,
  status: DetectStatus,
  note?: string
): DetectItem {
  return { group, key, label, expected, actual, status, ...(note ? { note } : {}) }
}

/** 只依赖实测值的自洽检查：不需要 profile 配置也能发现穿帮 */
function crossChecks(fp: FingerprintConfig, s: Snapshot, s2?: Snapshot): DetectItem[] {
  const out: DetectItem[] = []
  const G = '自洽 / 稳定性'

  const webdriver = get(s, 'webdriver')
  out.push(item(G, 'check.webdriver', 'navigator.webdriver 必须为 false', 'false', formatValue(webdriver), webdriver === false ? 'ok' : 'mismatch', '自动化最容易被抓到的一项'))

  const native = get(s, 'toStringNative')
  if (native !== undefined) {
    out.push(item(G, 'check.toStringNative', '被改写的 getter 仍伪装成 native code', 'true', formatValue(native), native === true ? 'ok' : 'mismatch'))
  }

  // 窗口尺寸 getter 是我们直接改在 window 实例上的，最容易漏掉 hideNative：
  // 一旦 toString 露出源码，getOwnPropertyDescriptor(window,'innerHeight') 就等于把注入脚本交给网站。
  const nativeWindow = get(s, 'toStringNativeWindow')
  if (nativeWindow !== undefined && nativeWindow !== null) {
    out.push(
      item(
        G,
        'check.toStringNativeWindow',
        '被改写的窗口尺寸 getter 仍伪装成 native code',
        'true',
        formatValue(nativeWindow),
        nativeWindow === true ? 'ok' : 'mismatch',
        'getOwnPropertyDescriptor(window, "innerHeight").get.toString() 会把注入源码整段吐给网站'
      )
    )
  }

  const nativeLayout = get(s, 'toStringNativeLayout')
  if (nativeLayout && typeof nativeLayout === 'object') {
    const map = nativeLayout as Record<string, unknown>
    const leaked = Object.entries(map)
      .filter(([, v]) => v === false)
      .map(([k]) => k)
    if (Object.keys(map).length) {
      out.push(
        item(
          G,
          'check.toStringNativeLayout',
          '被改写的布局视口 getter 仍伪装成 native code',
          'true',
          Object.keys(map).length === leaked.length ? '全部暴露' : leaked.length ? `暴露：${leaked.join(', ')}` : 'true',
          leaked.length === 0 ? 'ok' : 'mismatch',
          'clientHeight / offsetHeight / visualViewport.height 也被改写，同样要过 toString 检查'
        )
      )
    }
  }

  const nativeWin = get(s, 'toStringNativeWindow')
  if (nativeWin !== undefined && nativeWin !== null) {
    out.push(
      item(
        G,
        'check.toStringNativeWindow',
        '窗口尺寸 getter 也伪装成 native code',
        'true',
        formatValue(nativeWin),
        nativeWin === true ? 'ok' : 'mismatch',
        '否则读 Window.prototype 的属性描述符就能直接拿到注入脚本源码'
      )
    )
  }

  // UA 里的 Chrome 主版本 vs Client Hints 的 uaFullVersion 主版本
  const uaMajor = /Chrome\/(\d+)/.exec(String(get(s, 'userAgent') ?? ''))?.[1]
  const chFull = String(get(s, 'uaData.uaFullVersion') ?? '')
  const chMajor = chFull ? chFull.split('.')[0] : undefined
  if (uaMajor && chMajor) {
    out.push(item(G, 'check.uaVsCh', 'UA 主版本与 Client Hints 主版本一致', uaMajor, chMajor, uaMajor === chMajor ? 'ok' : 'mismatch', '两者不一致是最典型的穿帮点'))
  }

  if (fp.plugins.mode === 'chrome_default') {
    const len = Number(get(s, 'plugins.length') ?? 0)
    out.push(item(G, 'check.plugins', '插件列表非空（真实 Chrome 不会是 0）', '> 0', String(len), len > 0 ? 'ok' : 'mismatch'))
  }

  // 注意：不能用 document.fonts.check('未知字体') 判断伪造 ——
  // Chrome 对未知 family 会回退到默认字体并返回 true，这是正常行为，不是穿帮。

  if (fp.webgl.blockWebgl) {
    const supported = get(s, 'webgl.supported')
    out.push(item(G, 'check.blockWebgl', '已关闭 WebGL', 'false', formatValue(supported), supported === false ? 'ok' : 'mismatch'))
  }

  if (fp.canvas.mode !== 'off') {
    const len = Number(get(s, 'canvas.dataUrlLength') ?? 0)
    out.push(item(G, 'check.canvasNoise', 'Canvas 噪声已生效（toDataURL 长度异常）', '> 1000', String(len), len > 1000 ? 'ok' : 'mismatch'))
  }

  // 窗口内外尺寸必须自洽：inner 比 outer 大是注入层改了一半留下的典型痕迹
  const innerW = Number(get(s, 'window.innerWidth'))
  const innerH = Number(get(s, 'window.innerHeight'))
  const outerW = Number(get(s, 'window.outerWidth'))
  const outerH = Number(get(s, 'window.outerHeight'))
  if ([innerW, innerH, outerW, outerH].every((n) => Number.isFinite(n))) {
    const okBox = innerW <= outerW && innerH <= outerH && outerH - innerH <= 240 && outerW - innerW <= 40
    out.push(
      item(
        G,
        'check.windowBox',
        '窗口内外尺寸自洽（inner ≤ outer，且差值符合桌面 Chrome）',
        `${outerW}x${outerH} 内含 ${innerW}x${innerH}`,
        `${outerW}x${outerH} / ${innerW}x${innerH}`,
        okBox ? 'ok' : 'mismatch',
        '只改了 outer 或只改了 screen，检测站一比就发现窗口尺寸对不上'
      )
    )
  }

  // 注入层有没有偷偷改写窗口尺寸，用引擎真实布局来验：
  // 铺满视口的 fixed 元素高度由内核排版，JS 改不掉。
  // 只要 innerHeight 被动过，这两者就会差出黄条/装饰级别的一大截。
  const fixedW = Number(get(s, 'layout.fixedWidth'))
  const fixedH = Number(get(s, 'layout.fixedHeight'))
  if (Number.isFinite(fixedH) && Number.isFinite(innerH)) {
    const diff = Math.abs(innerH - fixedH)
    out.push(
      item(
        G,
        'check.viewportVsLayout',
        'innerHeight 等于引擎真实视口高度（未被改写）',
        String(fixedH),
        String(innerH),
        diff <= 2 ? 'ok' : 'mismatch',
        '铺满视口的 fixed 元素由内核排版，JS 改不掉；两者差出几十像素就说明 innerHeight 是伪造的'
      )
    )
  }
  if (Number.isFinite(fixedW) && Number.isFinite(innerW)) {
    const diff = innerW - fixedW
    // 宽度方向只允许差出一条滚动条（0-20px）
    out.push(
      item(
        G,
        'check.viewportWidthVsLayout',
        'innerWidth 与引擎真实视口宽度只差滚动条',
        '0 - 20',
        String(diff),
        diff >= 0 && diff <= 20 ? 'ok' : 'mismatch',
        '宽度方向出现异常差值同样是改写窗口尺寸留下的痕迹'
      )
    )
  }

  // 真实窗口必须真的开成 profile 配置的尺寸 —— 这是「不撒谎」方案的前提。
  // headless 没有真实窗口（探针会带 headed=0），跳过而不是误报。
  const headed = get(s, 'headed')
  const cfgW = Number(fp.screen.windowWidth)
  const cfgH = Number(fp.screen.windowHeight)
  if (
    headed !== false &&
    Number.isFinite(cfgW) &&
    Number.isFinite(cfgH) &&
    Number.isFinite(outerW) &&
    Number.isFinite(outerH)
  ) {
    const dw = Math.abs(outerW - cfgW)
    const dh = Math.abs(outerH - cfgH)
    // 窗口管理器按显示器工作区夹取窗口：请求 2812x1815 在 1512x982 的笔记本上
    // 只能落地成 2812x833。这不是注入撒谎，而是「本机显示器放不下这个尺寸」。
    // 用 injector 读回的 want/got 区分两种情况，避免把环境限制误报成穿帮。
    const wb = s.__windowBounds as
      | { want: { width: number; height: number }; got: { width: number; height: number } }
      | undefined
    const clamped =
      !!wb && (wb.got.width !== wb.want.width || wb.got.height !== wb.want.height)
    out.push(
      item(
        G,
        'check.windowSizing',
        '真实窗口已开成 profile 配置尺寸',
        `${cfgW}x${cfgH}`,
        `${outerW}x${outerH}`,
        dw <= 2 && dh <= 2
          ? 'ok'
          : clamped
            ? 'unknown'
            : 'mismatch',
        dw <= 2 && dh <= 2
          ? '靠 --window-size + CDP setWindowBounds 把真实窗口开成配置值，而不是改写 getter'
          : clamped
            ? `本机显示器放不下 ${wb?.want.width}x${wb?.want.height}，窗口管理器夹到 ${wb?.got.width}x${wb?.got.height}；换更大的显示器或调小 windowWidth / windowHeight`
            : '靠 --window-size + CDP setWindowBounds 把真实窗口开成配置值，而不是改写 getter'
      )
    )
    // 桌面 Chrome 的标签栏 + 地址栏 + 书签栏合计约 40-260px；
    // 差值为 0 是 headless / 被改写过 getter 的特征。
    const chrome = outerH - innerH
    out.push(
      item(
        G,
        'check.chromeHeight',
        '窗口装饰高度符合桌面 Chrome',
        '40 - 260',
        String(chrome),
        chrome >= 40 && chrome <= 260 ? 'ok' : 'mismatch',
        'inner 与 outer 完全相等是 headless 特征；过大则可能有 infobar'
      )
    )
  }

  // 两次采样：噪声必须由 seed 决定，跨页面 / 跨重启都必须一致
  // ---------- WebRTC ----------
  // 页面只要 new RTCPeerConnection() 就能读到内网 IP 与真实公网出口，
  // 完全绕过 --proxy-server。这一项不查，前面所有代理配置都是空的。
  const rtc = get(s, 'webrtc') as { supported?: boolean; candidates?: string[]; sdpCandidates?: string[] } | undefined
  if (rtc) {
    out.push(
      item(
        G,
        'check.webrtcSupported',
        'RTCPeerConnection 必须存在（真实 Chrome 一定有）',
        'true',
        formatValue(rtc.supported),
        rtc.supported === true ? 'ok' : 'mismatch',
        '直接删掉构造函数本身就是自动化 / 篡改特征'
      )
    )
    const lines = [...(rtc.candidates ?? []), ...(rtc.sdpCandidates ?? [])]
    const mode = fp.webrtc.mode
    if (mode === 'disable') {
      out.push(
        item(
          G,
          'check.webrtcDisabled',
          '已关闭 WebRTC：不应收集到任何 ICE 候选',
          '0 条',
          `${lines.length} 条`,
          lines.length === 0 ? 'ok' : 'mismatch',
          '候选会直接暴露真实内网与公网 IP'
        )
      )
    } else {
      // 「泄漏」指的是真实内网地址：profile 里配置的假内网地址本身就是私网段，
      // 不能算泄漏 —— 否则每个正常配置都会被自己判成 mismatch。
      const allowed = new Set(fp.webrtc.localIps)
      const leaked = lines.filter((l) => {
        const ip = candidateIp(l)
        if (!ip) return false
        if (allowed.has(ip)) return false
        return PRIVATE_IP.test(ip) || ip.endsWith('.local')
      })
      out.push(
        item(
          G,
          'check.webrtcNoLocalLeak',
          'ICE 候选不得暴露真实内网 / mDNS 地址',
          '0 条泄漏',
          `${leaked.length} 条泄漏`,
          leaked.length === 0 ? 'ok' : 'mismatch',
          leaked.length ? `泄漏样本：${leaked[0]}` : undefined
        )
      )
      if (fp.webrtc.localIps.length) {
        const hosts = lines.filter((l) => /\btyp host\b/.test(l)).map((l) => candidateIp(l)).filter(Boolean) as string[]
        const wrong = hosts.filter((h) => !allowed.has(h))
        out.push(
          item(
            G,
            'check.webrtcHostIps',
            'host 候选应等于 profile 配置的假内网地址',
            fp.webrtc.localIps.join(' / '),
            hosts.length ? [...new Set(hosts)].join(' / ') : '无 host 候选',
            wrong.length === 0 ? 'ok' : 'mismatch'
          )
        )
      }
      if (fp.webrtc.publicIp) {
        const srflx = lines
          .filter((l) => /\btyp (srflx|relay|prflx)\b/.test(l))
          .map((l) => candidateIp(l))
          .filter(Boolean) as string[]
        const bad = srflx.filter((ip) => ip !== fp.webrtc.publicIp)
        out.push(
          item(
            G,
            'check.webrtcPublicIp',
            'srflx/relay 候选应等于代理出口 IP',
            fp.webrtc.publicIp,
            srflx.length ? [...new Set(srflx)].join(' / ') : '无 srflx 候选',
            srflx.length === 0 ? 'unknown' : bad.length === 0 ? 'ok' : 'mismatch',
            '与代理出口不一致说明 UDP 绕过了代理'
          )
        )
      }
    }
  }

  // WebGPU 两条读取路径必须给出同一个答案：只补 info 或只补 requestAdapterInfo 都会露
  const gpuBoth = get(s, 'webgpu.bothAgree')
  if (gpuBoth !== undefined && gpuBoth !== null) {
    out.push(
      item(G, 'check.webgpuBothPaths', 'WebGPU adapter.info 与 requestAdapterInfo() 一致', 'true', formatValue(gpuBoth), gpuBoth === true ? 'ok' : 'mismatch', '新版走 info、旧版走 requestAdapterInfo，漏一条就被读到真 GPU')
    )
  }

  // WebGL 与 WebGPU 的 GPU 身份必须同源
  const glVendor = get(s, 'webgl.vendor')
  const gpuVendor = get(s, 'webgpu.vendor')
  if (glVendor !== undefined && gpuVendor !== undefined && gpuVendor !== null && glVendor !== null) {
    // 两个 API 的厂商字符串格式不同（ANGLE / Google Inc. (Apple) vs apple），
    // 所以比较的是「提到哪几家 GPU 厂商」，而不是字符串本身
    const fam = (v: unknown): string[] =>
      ['apple', 'nvidia', 'amd', 'intel', 'imagination', 'qualcomm', 'arm'].filter((n) =>
        new RegExp(n, 'i').test(String(v))
      )
    const a = fam(glVendor)
    const b = fam(gpuVendor)
    const clash = a.length > 0 && b.length > 0 && !a.some((x) => b.includes(x))
    out.push(
      item(G, 'check.gpuVendorCoherent', 'WebGL 与 WebGPU 的 GPU 厂商同源', String(glVendor), String(gpuVendor), clash ? 'mismatch' : 'ok', '只改 WebGL 不改 WebGPU 是最常见的穿帮')
    )
  }

  // 字体：canvas 与 DOM 两条探测路径必须回退到同一个兜底字体
  for (const [key, label, path] of [
    ['check.fontsCanvasFallback', 'canvas 里不存在的字体回退到兜底', 'fonts.canvasFallbackMatches'],
    ['check.fontsDomFallback', 'DOM 里不存在的字体回退到兜底', 'fonts.domFallbackMatches']
  ] as const) {
    const actual = get(s, path)
    if (actual === undefined || actual === null) continue
    out.push(
      item(G, key, label, 'true', formatValue(actual), actual === true ? 'ok' : 'mismatch', '只改 fonts.check 不改 measureText/CSS font 会让两条路径互相打脸')
    )
  }

  if (s2) {
    const pairs = [
      ['check.canvasStable', 'Canvas 指纹两次采样一致', 'canvas.hash'],
      ['check.audioStable', 'Audio 指纹两次采样一致', 'audio.hash'],
      ['check.textWidthStable', 'measureText 两次采样一致', 'canvas.textWidth'],
      ['check.glPixelsStable', 'WebGL readPixels 两次采样一致', 'webgl.pixels.hash'],
      ['check.audioAnalyserStable', 'AnalyserNode 频谱两次采样一致', 'audio.analyserFloatHash'],
      ['check.audioTimeStable', 'AnalyserNode 时域两次采样一致', 'audio.analyserTimeHash'],
      ['check.fontGhostStable', '字体回退宽度两次采样一致', 'fonts.ghostWidth']
    ] as const
    for (const [key, label, path] of pairs) {
      const a = get(s, path)
      const b = get(s2, path)
      if (a === undefined || b === undefined) continue
      out.push(
        item(G, key, label, formatValue(a), formatValue(b), same(a, b) ? 'ok' : 'mismatch', '噪声漂移会让同一环境每次都被判定成新设备')
      )
    }
  }

  return out
}

/**
 * 自动化痕迹与冷门 API 的比对。
 *
 * 这一组不是「指纹像不像别人」，而是「有没有暴露自己是被驱动的」：
 * 自动化残留属性、native 标记完整性、可见性、console getter 陷阱、
 * matchMedia / 语音 / 支付 / 解码能力。缺任何一项，Google 与 X 的 bot 评分都会扣分。
 */
function stealthChecks(fp: FingerprintConfig, s: Snapshot): DetectItem[] {
  const out: DetectItem[] = []
  const G = '自动化痕迹'
  const st = fp.stealth

  const leaks = get(s, 'stealth.automationProps')
  if (Array.isArray(leaks)) {
    out.push(
      item(
        G,
        'check.automationProps',
        'window / navigator 上无自动化残留属性',
        '0 个',
        leaks.length ? leaks.join(', ') : '0 个',
        leaks.length === 0 ? 'ok' : 'mismatch',
        'ChromeDriver / Playwright 会留下 cdc_ 之类的属性，这是最经典的判定项'
      )
    )
  }

  const notNative = get(s, 'stealth.patchedFns.notNative')
  if (Array.isArray(notNative)) {
    const total = Number(get(s, 'stealth.patchedFns.total') ?? 0)
    out.push(
      item(
        G,
        'check.nativeMarks',
        `被改写的 ${total} 个函数仍报告 [native code]`,
        '0 个破绽',
        notNative.length ? notNative.join(', ') : '0 个破绽',
        notNative.length === 0 ? 'ok' : 'mismatch',
        'BotGuard 会逐个验证改写过的函数，抽查式自检不够'
      )
    )
  }

  if (st.enabled && st.forceVisible) {
    const vs = get(s, 'stealth.visibilityState')
    const hidden = get(s, 'stealth.hidden')
    const focus = get(s, 'stealth.hasFocus')
    const bad = vs !== 'visible' || hidden !== false
    out.push(
      item(
        G,
        'check.visibility',
        '页面呈现为前台可见',
        'visible / hidden=false',
        `${formatValue(vs)} / hidden=${formatValue(hidden)} / hasFocus=${formatValue(focus)}`,
        bad ? 'mismatch' : 'ok',
        'headless 与后台窗口的 visibilityState 与真人不同，登录页会据此扣分'
      )
    )
  }

  if (st.enabled && st.chromeObject) {
    const present = get(s, 'stealth.chrome.present')
    const csi = get(s, 'stealth.chrome.csi')
    const app = get(s, 'stealth.chrome.app')
    out.push(
      item(
        G,
        'check.chromeObject',
        'window.chrome 及其成员存在',
        'object / function / object',
        `${formatValue(present)} / ${formatValue(csi)} / ${formatValue(app)}`,
        present === true && csi === 'function' && app === 'object' ? 'ok' : 'mismatch',
        '只有 navigator 像 Chrome 而 window.chrome 是空壳，是自动化环境的典型特征'
      )
    )
  }

  const trap = get(s, 'consoleGetterTrap.triggered')
  if (trap !== undefined) {
    out.push(
      item(
        G,
        'check.consoleTrap',
        'console.log(obj) 不触发对象 getter',
        st.consoleHardening ? 'false' : '—',
        formatValue(trap),
        st.consoleHardening ? (trap === false ? 'ok' : 'mismatch') : 'unknown',
        'CDP 的 Runtime.enable 会让 console 序列化对象，站点用这个技巧判断「有没有调试器挂着」'
      )
    )
  }

  if (st.enabled && st.voices.length > 0) {
    const n = Number(get(s, 'stealth.voices') ?? -1)
    out.push(
      item(
        G,
        'check.voices',
        'speechSynthesis.getVoices() 非空',
        `>= ${st.voices.length}`,
        String(n),
        n >= st.voices.length ? 'ok' : 'mismatch',
        '空语音列表是 headless 与精简内核的典型特征'
      )
    )
  }

  if (st.enabled && st.payment.enabled) {
    const p = get(s, 'stealth.paymentCanMakePayments')
    out.push(
      item(
        G,
        'check.payment',
        'PaymentRequest.canMakePayments()',
        String(st.payment.canMakePayments),
        formatValue(p),
        p === st.payment.canMakePayments ? 'ok' : 'mismatch',
        'Google 用它验证「真实 Chrome + 支付能力」，返回 undefined 会被记为异常'
      )
    )
  }

  // matchMedia：冷门媒体特性必须与 UA / 触屏 / 显示模式配置同源
  const MQ: [string, string, unknown][] = [
    ['check.mqColorScheme', '(prefers-color-scheme: dark)', st.colorScheme === 'dark'],
    ['check.mqPointer', '(pointer: fine)', st.pointer === 'fine'],
    ['check.mqHover', '(hover: hover)', st.hover === 'hover'],
    ['check.mqDisplayMode', '(display-mode: browser)', st.displayMode === 'browser'],
    ['check.mqReducedMotion', '(prefers-reduced-motion: reduce)', st.prefersReducedMotion]
  ]
  for (const [key, query, want] of MQ) {
    const table = s.mediaQueries as Record<string, { matches: boolean }> | undefined
    const node = table ? table[query] : undefined
    if (!node) continue
    const got = node.matches
    out.push(
      item(G, key, `matchMedia ${query}`, String(want), String(got), got === want ? 'ok' : 'mismatch', '媒体特性与触屏 / 显示模式配置矛盾说明只改了表面')
    )
  }

  // 解码能力：缺 H.264 / AAC 一眼就是无编解码器的 Chromium 快照
  const CODEC_KEY: Record<string, string> = {
    h264: 'video/mp4;codecs="avc1.42E01E"',
    vp9: 'video/webm;codecs="vp9"',
    av1: 'video/webm;codecs="av01.0.05M.08"',
    aac: 'audio/mp4;codecs="mp4a.40.2"',
    mp3: 'audio/mpeg',
    opus: 'audio/webm;codecs=opus'
  }
  for (const [name, key] of Object.entries(CODEC_KEY)) {
    const want = (st.codecs as unknown as Record<string, boolean>)[name]
    // 编解码串里带点（avc1.42E01E），不能用按 '.' 分层的 get()
    const table = s.mediaCodecs as Record<string, unknown> | undefined
    const node = table ? table[key] : undefined
    if (node === undefined) continue
    out.push(
      item(
        G,
        `check.codec.${name}`,
        `MediaCapabilities 解码 ${name}`,
        String(want),
        formatValue(node),
        node === want ? 'ok' : 'mismatch',
        '解码能力与 UA 声明的浏览器品牌不符（正式版 Chrome 必然支持 H.264/AAC）'
      )
    )
  }

  // canPlayType：<video> 元素层面的能力。它与 MediaCapabilities 必须同源，
  // 而且是最直白的「内核是不是品牌化正式版」探针 —— 未品牌化构建缺 H.264/AAC。
  const CPT: [string, string, keyof typeof st.codecs][] = [
    ['check.cptH264', 'canPlayType H.264', 'h264'],
    ['check.cptAac', 'canPlayType AAC', 'aac'],
    ['check.cptMp3', 'canPlayType MP3', 'mp3'],
    ['check.cptVp8', 'canPlayType VP8', 'vp8'],
    ['check.cptVp9', 'canPlayType VP9', 'vp9']
  ]
  const CPT_KEY: Record<string, string> = {
    h264: 'video/mp4;codecs="avc1.42E01E"',
    aac: 'audio/mp4;codecs="mp4a.40.2"',
    mp3: 'audio/mpeg',
    vp8: 'video/webm;codecs="vp8,vorbis"',
    vp9: 'video/webm;codecs="vp9"'
  }
  const cptTable = s.canPlayType as Record<string, string> | undefined
  if (cptTable) {
    for (const [key, label, codec] of CPT) {
      const got = cptTable[CPT_KEY[codec]]
      if (got === undefined) continue
      const want = st.codecs[codec] ? 'probably' : 'no'
      out.push(
        item(
          G,
          key,
          label,
          want,
          got,
          got === want ? 'ok' : 'mismatch',
          'canPlayType 与 MediaCapabilities 不一致，或正式版该有的编解码缺失，都会暴露内核构建类型'
        )
      )
    }
  }

  // Widevine：真实 Chrome 自带 CDM。声明支持 H.264/AAC 却拿不到 Widevine，
  // 说明用的是 Chromium 快照 / Chrome for Testing，而不是用户机器上的 Chrome。
  const wv = s.widevine as { available?: boolean; keySystem?: string | null } | undefined
  if (wv && typeof wv.available === 'boolean') {
    const want = st.codecs.h264 && st.codecs.aac
    out.push(
      item(
        G,
        'check.widevine',
        'Widevine CDM 可用（requestMediaKeySystemAccess）',
        String(want),
        String(wv.available),
        wv.available === want ? 'ok' : 'mismatch',
        want
          ? '缺 Widevine 是未品牌化构建的硬特征，Google 会用它辅助判断内核来源。' +
            'Chrome for Testing / Playwright Chromium 不带 Widevine；' +
            '正式版 Chrome 若被加了 --disable-component-update 也会注册不上 CDM。'
          : '缺 Widevine 是未品牌化构建的硬特征，Google 会用它辅助判断内核来源'
      )
    )
  }

  // 补丁内核标记：只作说明，不参与打分（官方内核没有标记是正常的）
  const marker = s.kernelMarker
  if (marker !== undefined) {
    out.push(
      item(
        G,
        'check.kernelMarker',
        '内核补丁标记（window.__fpbKernel）',
        '官方内核为 null',
        marker === null ? 'null（官方内核）' : formatValue(marker),
        'unknown',
        '只有自编译内核才能改渲染管线与 ClientHello；JS 注入改不了这些'
      )
    )
  }

  return out
}

export function compareSignals(fp: FingerprintConfig, s: Snapshot, s2?: Snapshot): DetectItem[] {
  const items: DetectItem[] = []
  for (const rule of ALL_RULES) {
    const exp = rule.expected(fp)
    const act = get(s, rule.actual)
    const expectedText = exp === undefined ? '—' : formatValue(exp)
    const actualText = act === undefined ? '—' : formatValue(act)
    const status: DetectStatus = exp === undefined || act === undefined ? 'unknown' : same(exp, act, rule.tolerance) ? 'ok' : 'mismatch'
    items.push(item(rule.group, rule.key, rule.label, expectedText, actualText, status, rule.note))
  }
  items.push(...crossChecks(fp, s, s2))
  items.push(...stealthChecks(fp, s))
  return items
}

export interface DetectSummary {
  ok: number
  mismatch: number
  unknown: number
  score: number
}

export function summarize(items: DetectItem[]): DetectSummary {
  const ok = items.filter((i) => i.status === 'ok').length
  const mismatch = items.filter((i) => i.status === 'mismatch').length
  const unknown = items.filter((i) => i.status === 'unknown').length
  const judged = ok + mismatch
  return { ok, mismatch, unknown, score: judged === 0 ? 0 : Math.round((ok / judged) * 100) }
}