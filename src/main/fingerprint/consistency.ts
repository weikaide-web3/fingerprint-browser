import { tzOffsetMinutes } from './generator'
import type { ConsistencyIssue, ConsistencyReport, FingerprintConfig, OsPlatform } from '@shared/types'

/**
 * 指纹一致性体检：把 FingerprintConfig 里互相牵制的字段两两比对，
 * 输出可定位到具体字段的问题清单。对标 AdsPower / MoreLogin 的
 * 「指纹自检」，目的是拦住那些一眼就能被检测脚本识破的组合。
 */

export interface ConsistencyContext {
  /** 绑定代理的出口 IP，用于与 WebRTC publicIp 比对 */
  proxyIp?: string | null
  /** 绑定代理的出口时区，用于与指纹时区比对 */
  proxyTimezone?: string | null
  /** 计算时区偏移的时点（含夏令时），默认当前时间 */
  at?: Date
  /**
   * 实际会启动的内核版本（如 153.0.8010.12）。
   * 提供时会与 UA / Client Hints 声明的版本做硬比对 ——
   * JS 层的 UA 可以改写，但 TLS ClientHello、HTTP/2 指纹、媒体解码能力
   * 都来自真实内核，声明版本与内核版本差太多就是最典型的穿帮点。
   */
  kernelVersion?: string | null
}

/**
 * 「硬伤」问题码：这些矛盾会让 UA 与内核真实特征互相打脸，
 * 保存时直接拒绝，而不是只在体检里扣分。
 * X 的 x-client-transaction-id 按 UA 版本索引密钥、Google 按 TLS 形状反推浏览器版本，
 * 两者都会把这类配置直接判为机器人。
 */
export const HARD_ISSUE_CODES = new Set([
  'UA_EMPTY',
  'UA_VERSION',
  'UA_MAJOR',
  'UA_OS',
  'CH_FULL_VERSION',
  'CH_FULL_VERSION_LIST',
  'CH_BRANDS_MAJOR',
  'CH_PLATFORM',
  'UA_KERNEL_NEWER',
  'UA_KERNEL_DRIFT'
])

export function blockingIssues(report: ConsistencyReport): ConsistencyIssue[] {
  return report.issues.filter((i) => HARD_ISSUE_CODES.has(i.code))
}

/** 从版本串取大版本号 */
export function majorOf(version: string | null | undefined): number | null {
  if (!version) return null
  const m = /^(\d+)/.exec(String(version).trim())
  return m ? Number(m[1]) : null
}

/** sec-ch-ua-platform 取值（与 UA 里的系统 token 不是一回事） */
const CH_PLATFORM: Record<OsPlatform, string> = {
  macOS: 'macOS',
  Windows: 'Windows',
  Linux: 'Linux',
  Android: 'Android',
  iOS: 'iOS'
}

/** navigator.platform 取值 */
const NAV_PLATFORM: Record<OsPlatform, string> = {
  macOS: 'macOS',
  Windows: 'Win32',
  Linux: 'Linux x86_64',
  Android: 'Linux armv8l',
  iOS: 'iPhone'
}

/** UA 里必须出现的系统 token */
const UA_OS_TOKENS: Record<OsPlatform, string[]> = {
  macOS: ['Macintosh'],
  Windows: ['Windows NT'],
  Linux: ['X11', 'Linux'],
  Android: ['Android'],
  iOS: ['iPhone', 'iPad']
}

/** 品牌家族在 sec-ch-ua 里的正式品牌名 */
const FAMILY_BRAND: Record<string, string> = {
  Chrome: 'Google Chrome',
  Edge: 'Microsoft Edge',
  Firefox: 'Firefox',
  Safari: 'Safari'
}

/** navigator.deviceMemory 只会是这几个离散值 */
const VALID_DEVICE_MEMORY = [0.25, 0.5, 1, 2, 4, 8, 16, 32]
/** 真实设备常见的逻辑核心数 */
const COMMON_CORES = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32]

const MAC_ONLY_FONTS = ['Helvetica Neue', 'Menlo', 'Monaco', 'Avenir Next', 'Optima', 'Didot', 'Futura', 'Chalkboard SE']
const WINDOWS_ONLY_FONTS = ['Segoe UI', 'Microsoft YaHei', 'Bahnschrift', 'Cambria', 'Consolas', 'Corbel', 'Candara']

/** Apple GPU 的 WebGL renderer 形状 */
const APPLE_RENDERER = /^Apple (M\d|A\d+|Silicon|GPU|Intel)/i

export function validateFingerprint(fp: FingerprintConfig, ctx: ConsistencyContext = {}): ConsistencyReport {
  const issues: ConsistencyIssue[] = []
  const at = ctx.at ?? new Date()

  const add = (level: ConsistencyIssue['level'], code: string, message: string, fields: string[]): void => {
    issues.push({ level, code, message, fields })
  }

  const os = fp.ua.os
  const major = fp.ua.major
  const isChromiumFamily = fp.ua.browser === 'Chrome' || fp.ua.browser === 'Edge'

  // ---------- 1. UA 自身 ----------
  const ua = fp.ua.ua ?? ''
  if (!ua) {
    add('error', 'UA_EMPTY', 'User-Agent 为空', ['ua.ua'])
  } else {
    if (isChromiumFamily && !ua.includes(`Chrome/${fp.ua.version}`)) {
      add('error', 'UA_VERSION', `UA 里的 Chrome 版本 ${fp.ua.version} 与 UA 字符串不一致`, ['ua.ua', 'ua.version'])
    }
    const parsedMajor = Number.parseInt((fp.ua.version || '').split('.')[0], 10)
    if (!Number.isFinite(parsedMajor) || parsedMajor !== major) {
      add('error', 'UA_MAJOR', `UA 大版本号 ${major} 与完整版本 ${fp.ua.version} 不一致`, ['ua.major', 'ua.version'])
    }
    if (!UA_OS_TOKENS[os].some((token) => ua.includes(token))) {
      add('error', 'UA_OS', `UA 字符串与声明的系统 ${os} 不匹配`, ['ua.ua', 'ua.os'])
    }
    if (fp.ua.mobile && !/Mobile|Android|iPhone/.test(ua)) {
      add('warn', 'UA_MOBILE', '声明为移动端，但 UA 里没有移动设备 token', ['ua.mobile', 'ua.ua'])
    }
  }

  // ---------- 2. Client Hints 必须与 UA 严格一致 ----------
  const ch = fp.clientHints
  if (isChromiumFamily && !ch.enabled) {
    add('warn', 'CH_DISABLED', `${fp.ua.browser} 一定会发送 Client Hints，关闭后反而暴露`, ['clientHints.enabled'])
  }
  if (ch.enabled) {
    if (!isChromiumFamily) {
      add('error', 'CH_NOT_CHROMIUM', `${fp.ua.browser} 不发送 sec-ch-ua，开启 Client Hints 会自相矛盾`, [
        'ua.browser',
        'clientHints.enabled'
      ])
    }
    if (ch.uaFullVersion !== fp.ua.version) {
      add('error', 'CH_FULL_VERSION', `sec-ch-ua 完整版本 ${ch.uaFullVersion} 与 UA 版本 ${fp.ua.version} 不一致`, [
        'clientHints.uaFullVersion',
        'ua.version'
      ])
    }
    const familyBrand = FAMILY_BRAND[fp.ua.browser] ?? 'Chromium'
    const brandHit = ch.brands.some(
      (b) => (b.brand === familyBrand || b.brand === 'Chromium') && b.version === String(major)
    )
    if (!brandHit) {
      add('error', 'CH_BRANDS_MAJOR', `sec-ch-ua 里没有 ${familyBrand} v${major}，与 UA 大版本对不上`, [
        'clientHints.brands',
        'ua.major'
      ])
    }
    const fullHit = ch.fullVersionList.some((b) => b.brand === familyBrand && b.version === ch.uaFullVersion)
    if (!fullHit) {
      add('warn', 'CH_FULL_VERSION_LIST', 'sec-ch-ua-full-version-list 缺少与品牌对应的完整版本项', [
        'clientHints.fullVersionList'
      ])
    }
    if (ch.platform !== CH_PLATFORM[os]) {
      add('error', 'CH_PLATFORM', `sec-ch-ua-platform "${ch.platform}" 与 UA 系统 ${os} 不一致`, [
        'clientHints.platform',
        'ua.os'
      ])
    }
    if (ch.mobile !== fp.ua.mobile) {
      add('warn', 'CH_MOBILE', `sec-ch-ua-mobile=${ch.mobile} 与 UA 移动端标记 ${fp.ua.mobile} 不一致`, [
        'clientHints.mobile',
        'ua.mobile'
      ])
    }
    if (ch.architecture && fp.hardware.cpuArchitecture && ch.architecture !== fp.hardware.cpuArchitecture) {
      add('warn', 'CH_ARCH', `sec-ch-ua-architecture ${ch.architecture} 与 CPU 架构 ${fp.hardware.cpuArchitecture} 不一致`, [
        'clientHints.architecture',
        'hardware.cpuArchitecture'
      ])
    }
    if (ch.bitness && fp.hardware.bitness && ch.bitness !== fp.hardware.bitness) {
      add('warn', 'CH_BITNESS', `sec-ch-ua-bitness ${ch.bitness} 与硬件位宽 ${fp.hardware.bitness} 不一致`, [
        'clientHints.bitness',
        'hardware.bitness'
      ])
    }
  }

  // ---------- 2.5 声明版本 vs 真实内核版本 ----------
  // JS 层的 UA / Client Hints 是改写出来的，但 TLS ClientHello、HTTP/2 SETTINGS、
  // 媒体解码能力、新增 API 的可用性都来自真实内核。声明版本比内核新 = 声称拥有内核没有的能力，
  // 是最容易被服务端反推出来的矛盾（Google 会按 TLS 形状反推 Chrome 版本并与 UA 比对）。
  if (isChromiumFamily && ctx.kernelVersion) {
    const kernelMajor = majorOf(ctx.kernelVersion)
    if (kernelMajor === null) {
      add('warn', 'KERNEL_VERSION_PARSE', `无法解析内核版本号「${ctx.kernelVersion}」，跳过版本一致性检查`, ['kernelVersion'])
    } else if (kernelMajor !== major) {
      if (major > kernelMajor) {
        add(
          'error',
          'UA_KERNEL_NEWER',
          `UA 声明 ${fp.ua.browser} ${major}，但实际内核是 ${ctx.kernelVersion}（大版本 ${kernelMajor}）。` +
            '声明比内核新会让 TLS/HTTP2 指纹与媒体能力对不上，服务端可直接判定为伪造',
          ['ua.version', 'clientHints.uaFullVersion', 'kernelVersion']
        )
      } else if (kernelMajor - major <= 2) {
        add(
          'warn',
          'UA_KERNEL_MINOR_DRIFT',
          `UA 声明 ${major}，实际内核 ${ctx.kernelVersion}（大版本 ${kernelMajor}）：相差 ${kernelMajor - major} 个大版本，` +
            'TLS 形状仍可能不一致，建议用「自动」模式对齐',
          ['ua.version', 'kernelVersion']
        )
      } else {
        add(
          'error',
          'UA_KERNEL_DRIFT',
          `UA 声明 ${major}，实际内核 ${ctx.kernelVersion}（大版本 ${kernelMajor}）：相差 ${kernelMajor - major} 个大版本，` +
            'TLS/HTTP2/媒体能力必然穿帮',
          ['ua.version', 'clientHints.uaFullVersion', 'kernelVersion']
        )
      }
    }
  }

  // ---------- 3. 屏幕 / 窗口 ----------
  const sc = fp.screen
  if (sc.availWidth > sc.width || sc.availHeight > sc.height) {
    add('error', 'SCREEN_AVAIL', `可用区域 ${sc.availWidth}×${sc.availHeight} 大于屏幕 ${sc.width}×${sc.height}`, [
      'screen.availWidth',
      'screen.availHeight'
    ])
  }
  if (sc.windowWidth > sc.width || sc.windowHeight > sc.availHeight) {
    add('error', 'SCREEN_WINDOW', `窗口 ${sc.windowWidth}×${sc.windowHeight} 超出可用屏幕区域`, [
      'screen.windowWidth',
      'screen.windowHeight'
    ])
  }
  const portrait = sc.orientationType.startsWith('portrait')
  if (portrait !== sc.height > sc.width) {
    add('error', 'SCREEN_ORIENTATION', `屏幕方向 ${sc.orientationType} 与 ${sc.width}×${sc.height} 矛盾`, [
      'screen.orientationType'
    ])
  }
  if (os === 'macOS' && sc.devicePixelRatio < 2) {
    add('warn', 'SCREEN_DPR', `macOS pixelRatio=${sc.devicePixelRatio} 偏低，真实 Mac 基本都是 2 以上`, [
      'screen.devicePixelRatio'
    ])
  }
  const primaryMonitor = sc.monitors.find((m) => m.isDefault) ?? sc.monitors[0]
  if (primaryMonitor && (primaryMonitor.width !== sc.width || primaryMonitor.height !== sc.height)) {
    add(
      'warn',
      'SCREEN_MONITOR',
      `主显示器 ${primaryMonitor.width}×${primaryMonitor.height} 与 screen ${sc.width}×${sc.height} 不一致`,
      ['screen.monitors']
    )
  }

  // ---------- 4. WebGL / WebGPU 必须与系统匹配 ----------
  const gl = fp.webgl
  if (!gl.enabled || gl.blockWebgl) {
    add('info', 'WEBGL_BLOCKED', 'WebGL 被屏蔽，检测站会拿到 "WebGL not supported" 这类高区分度信号', ['webgl.enabled'])
  } else if (os === 'macOS') {
    // Mac 上的 ANGLE 后端是 OpenGL / Metal，出现 Direct3D 就是 Windows 的 GPU 串
    if (/Direct3D|D3D\d/i.test(gl.renderer)) {
      add('error', 'WEBGL_GPU_OS', `macOS 环境的 WebGL renderer 带 Direct3D 后端：${gl.renderer}`, [
        'webgl.vendor',
        'webgl.renderer'
      ])
    } else if (APPLE_RENDERER.test(gl.renderer) && gl.vendor !== 'Apple Inc.') {
      add('error', 'WEBGL_GPU_VENDOR', `WebGL renderer 是 Apple GPU，但 vendor 报告 ${gl.vendor}`, [
        'webgl.vendor',
        'webgl.renderer'
      ])
    }
  } else if (os === 'Windows') {
    if (gl.vendor === 'Apple Inc.' || /OpenGL ES 2\.0 macOS/i.test(gl.renderer)) {
      add('error', 'WEBGL_GPU_OS', `Windows 环境的 WebGL 报告了 Mac GPU：${gl.vendor} / ${gl.renderer}`, [
        'webgl.vendor',
        'webgl.renderer'
      ])
    }
  }
  if (gl.blockWebgl && fp.webgpu.enabled) {
    add('warn', 'WEBGL_WEBGPU_CONFLICT', '屏蔽了 WebGL 却开放 WebGPU，两个 API 的存在性互相矛盾', [
      'webgl.blockWebgl',
      'webgpu.enabled'
    ])
  }
  if (fp.webgpu.enabled) {
    const vendor = (fp.webgpu.vendor || '').toLowerCase()
    // Intel Mac 仍在大量在用（数据集里就有 intel-uhd-macos 预设），不能只认 apple
    const allowed = os === 'macOS' ? ['apple', 'intel'] : ['nvidia', 'intel', 'amd', 'apple']
    if (!allowed.includes(vendor)) {
      add('warn', 'WEBGPU_VENDOR', `WebGPU vendor "${fp.webgpu.vendor}" 与系统 ${os} 常见 GPU 厂商不符`, ['webgpu.vendor'])
    }
    // 真正的硬约束：WebGPU 与 WebGL 说的是同一块显卡。
    // 检测站会同时读这两个 API，厂商不同源 = 一眼假。
    const family = (v: string): string[] =>
      ['apple', 'nvidia', 'amd', 'intel', 'imagination', 'qualcomm'].filter((n) => v.includes(n))
    const glFamily = family(`${gl.vendor} ${gl.renderer}`.toLowerCase())
    const gpuFamily = family(vendor)
    if (!gl.blockWebgl && glFamily.length && gpuFamily.length && !glFamily.some((f) => gpuFamily.includes(f))) {
      add(
        'error',
        'WEBGPU_GL_CONFLICT',
        `WebGPU 厂商（${fp.webgpu.vendor}）与 WebGL 厂商（${gl.vendor}）不是同一块显卡`,
        ['webgpu.vendor', 'webgl.vendor']
      )
    }
  }

  // ---------- 5. 硬件规格 ----------
  const hw = fp.hardware
  if (hw.platform !== NAV_PLATFORM[os]) {
    add('error', 'HW_PLATFORM', `navigator.platform "${hw.platform}" 与 UA 系统 ${os} 不一致`, ['hardware.platform', 'ua.os'])
  }
  if (!COMMON_CORES.includes(hw.hardwareConcurrency)) {
    add('info', 'HW_CONCURRENCY', `逻辑核心数 ${hw.hardwareConcurrency} 不是常见取值`, ['hardware.hardwareConcurrency'])
  }
  if (!VALID_DEVICE_MEMORY.includes(hw.deviceMemory)) {
    add('warn', 'HW_MEMORY', `deviceMemory ${hw.deviceMemory} 不是 Chrome 会暴露的离散值`, ['hardware.deviceMemory'])
  }
  if (!fp.ua.mobile && hw.maxTouchPoints > 0) {
    add('warn', 'HW_TOUCH', `桌面端 UA 却报告 maxTouchPoints=${hw.maxTouchPoints}，触屏信号矛盾`, ['hardware.maxTouchPoints'])
  }

  // ---------- 6. 时区 / 地理位置 ----------
  const realOffset = tzOffsetMinutes(fp.timezone.id, at)
  if (fp.timezone.offsetMinutes !== realOffset) {
    add(
      'error',
      'TZ_OFFSET',
      `时区 ${fp.timezone.id} 当前偏移应为 ${realOffset} 分钟，配置里是 ${fp.timezone.offsetMinutes}`,
      ['timezone.offsetMinutes']
    )
  }
  if (fp.geolocation.enabled && fp.geolocation.timezoneId && fp.geolocation.timezoneId !== fp.timezone.id) {
    add('error', 'GEO_TZ', `地理位置时区 ${fp.geolocation.timezoneId} 与指纹时区 ${fp.timezone.id} 不一致`, [
      'geolocation.timezoneId',
      'timezone.id'
    ])
  }
  if (ctx.proxyTimezone && ctx.proxyTimezone !== fp.timezone.id) {
    add('warn', 'PROXY_TZ', `代理出口时区 ${ctx.proxyTimezone} 与指纹时区 ${fp.timezone.id} 不一致，IP 定位会露馅`, [
      'timezone.id'
    ])
  }

  // ---------- 7. 语言 ----------
  if (fp.language.languages.length === 0) {
    add('warn', 'LANG_EMPTY', 'navigator.languages 为空', ['language.languages'])
  } else {
    const primaryLanguage = fp.language.languages[0]
    if (!fp.language.acceptLanguage.toLowerCase().startsWith(primaryLanguage.toLowerCase())) {
      add(
        'warn',
        'LANG_ACCEPT',
        `Accept-Language "${fp.language.acceptLanguage}" 与 navigator.languages[0] ${primaryLanguage} 不一致`,
        ['language.acceptLanguage', 'language.languages']
      )
    }
    if (!fp.language.languages.some((l) => l.toLowerCase().startsWith(fp.language.intlLocale.toLowerCase()))) {
      add('warn', 'LANG_INTL', `Intl locale ${fp.language.intlLocale} 不在 navigator.languages 里`, ['language.intlLocale'])
    }
  }

  // ---------- 8. 字体 ----------
  if (fp.fonts.mode === 'custom') {
    if (fp.fonts.families.length === 0) {
      add('warn', 'FONTS_EMPTY', '字体模式为自定义但列表为空', ['fonts.families'])
    } else if (os === 'macOS') {
      const foreign = fp.fonts.families.filter((f) => WINDOWS_ONLY_FONTS.includes(f))
      if (foreign.length) add('warn', 'FONTS_OS', `macOS 环境里出现 Windows 专属字体：${foreign.join(', ')}`, ['fonts.families'])
    } else if (os === 'Windows') {
      const foreign = fp.fonts.families.filter((f) => MAC_ONLY_FONTS.includes(f))
      if (foreign.length) add('warn', 'FONTS_OS', `Windows 环境里出现 macOS 专属字体：${foreign.join(', ')}`, ['fonts.families'])
    }
  }

  // ---------- 9. WebRTC / 网络 ----------
  if (fp.webrtc.mode !== 'disable' && fp.webrtc.publicIp && ctx.proxyIp && fp.webrtc.publicIp !== ctx.proxyIp) {
    add('warn', 'WEBRTC_IP', `WebRTC 公网 IP ${fp.webrtc.publicIp} 与代理出口 ${ctx.proxyIp} 不一致`, ['webrtc.publicIp'])
  }
  const conn = fp.connection
  if (conn.enabled) {
    if (conn.effectiveType === '4g' && conn.rtt > 400) {
      add('warn', 'CONNECTION_RTT', `effectiveType=4g 但 rtt=${conn.rtt}ms`, ['connection.rtt'])
    }
    if (conn.effectiveType === '3g' && conn.rtt < 100) {
      add('warn', 'CONNECTION_RTT', `effectiveType=3g 但 rtt=${conn.rtt}ms 偏快`, ['connection.rtt'])
    }
  }
  if (fp.storage.quota < 1024 * 1024 * 1024) {
    add('info', 'STORAGE_QUOTA', `存储配额 ${Math.round(fp.storage.quota / 1024 / 1024)}MB 偏低`, ['storage.quota'])
  }

  // ---------- 10. 插件 / 机器标识 / 启动参数 ----------
  if (fp.plugins.mode === 'custom' && fp.plugins.plugins.length === 0) {
    add('warn', 'PLUGINS_EMPTY', '插件模式为自定义但插件列表为空', ['plugins.plugins'])
  }
  if (!fp.machine.machineId || !fp.machine.deviceId) {
    add('warn', 'MACHINE_IDS', '机器级标识为空，配套 App 读取时会拿到空值', ['machine.machineId', 'machine.deviceId'])
  }
  if (fp.launch.bypassCSP || fp.launch.ignoreCertificateErrors) {
    add('info', 'LAUNCH_RISK', '开启了 bypassCSP / ignoreCertificateErrors，这类开关本身是可检测特征', ['launch'])
  }
  if (fp.canvas.mode !== 'off' && fp.canvas.seed && !fp.canvas.seed.startsWith(fp.seed)) {
    add('info', 'SEED_DERIVED', 'Canvas 噪声 seed 未从主 seed 派生，重新生成时不会同步变化', ['canvas.seed'])
  }

  const errors = issues.filter((i) => i.level === 'error').length
  const warns = issues.filter((i) => i.level === 'warn').length
  const infos = issues.filter((i) => i.level === 'info').length
  const score = Math.max(0, 100 - errors * 12 - warns * 4 - infos)

  return { issues, score, errors, warns, infos }
}


