import { createHash, randomBytes } from 'node:crypto'
import type {
  FingerprintConfig,
  FingerprintMode,
  OsPlatform,
  PermissionsConfig,
  UaConfig,
  ClientHintsConfig,
  ScreenConfig,
  WebGLConfig,
  HardwareConfig,
  LanguageConfig,
  TimezoneConfig,
  WebAuthnConfig,
  StealthConfig
} from '@shared/types'
import { generateAcceptLanguage, sanitizeLanguageTags } from '@shared/lang'
import {
  CHROME_VERSIONS,
  DEVICE_MEMORY,
  GPU_PRESETS,
  HARDWARE_CONCURRENCY,
  LANGUAGE_PRESETS,
  MAC_FONTS,
  MAC_VOICES,
  NOT_BRANDS,
  SCREEN_PRESETS,
  TIMEZONES,
  WINDOWS_FONTS,
  WINDOWS_VOICES,
  webgpuFor,
  type GpuPreset,
  type WebGpuInfo
} from './datasets'

export interface GenerateOptions {
  seed?: string
  os?: OsPlatform
  timezone?: string
  locale?: string
  /** 内核真实版本（auto 模式下用于保证 Client Hints 一致） */
  kernelVersion?: string
  mode?: FingerprintMode
  /** 代理出口 IP 信息，用于 sync_ip 模式 */
  ip?: { country?: string; timezone?: string; ip?: string } | null
}

export function makeSeed(): string {
  return randomBytes(12).toString('hex')
}

export function hashSeed(seed: string): number {
  return parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0
}

export function createRng(seed: string): () => number {
  let a = hashSeed(seed)
  return function next(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length]
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

export function hex(rng: () => number, len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) out += Math.floor(rng() * 16).toString(16)
  return out
}

/** 计算时区相对 UTC 的分钟偏移（含夏令时） */
export function tzOffsetMinutes(timeZone: string, date = new Date()): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const parts: Record<string, number> = {}
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
}

function uaString(os: OsPlatform, full: string): string {
  const osToken = os === 'macOS' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`
}

function buildUa(os: OsPlatform, full: string, major: number): UaConfig {
  return {
    ua: uaString(os, full),
    browser: 'Chrome',
    version: full,
    major,
    os,
    // 精简 UA 中 macOS 恒为 10_15_7，真实系统版本放在 Client Hints
    osVersion: os === 'macOS' ? '10_15_7' : '10.0',
    mobile: false
  }
}

function buildClientHints(os: OsPlatform, full: string, major: number, rng: () => number): ClientHintsConfig {
  const notBrand = pick(rng, NOT_BRANDS)
  return {
    enabled: true,
    brands: [
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
      notBrand
    ],
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
      { brand: notBrand.brand, version: notBrand.version }
    ],
    platform: os === 'macOS' ? 'macOS' : 'Windows',
    platformVersion: os === 'macOS' ? '15.5.0' : '15.0.0',
    architecture: os === 'macOS' ? 'arm' : 'x86',
    bitness: '64',
    model: '',
    formFactors: ['Desktop'],
    mobile: false,
    uaFullVersion: full,
    wow64: false
  }
}

function buildScreen(os: OsPlatform, rng: () => number): ScreenConfig {
  const sameOs = SCREEN_PRESETS.filter((s) => s.os === os)
  const preset = pick(rng, sameOs.length ? sameOs : SCREEN_PRESETS)
  const menuBar = os === 'macOS' ? 24 : 0
  const taskBar = os === 'Windows' ? 48 : 0
  const availHeight = preset.height - menuBar - taskBar
  return {
    width: preset.width,
    height: preset.height,
    availWidth: preset.width,
    availHeight,
    availLeft: 0,
    availTop: menuBar,
    colorDepth: 30,
    pixelDepth: 30,
    devicePixelRatio: preset.dpr,
    orientationType: 'landscape-primary',
    orientationAngle: 0,
    monitors: [{ x: 0, y: 0, width: preset.width, height: preset.height, scaleFactor: preset.dpr, isDefault: true }],
    windowWidth: Math.min(preset.width - randInt(rng, 40, 260), preset.width),
    windowHeight: Math.min(availHeight - randInt(rng, 40, 200), availHeight)
  }
}

/** WebGL 与 WebGPU 必须来自同一块显卡预设，所以一次选出、两处使用 */
function buildGpu(os: OsPlatform, rng: () => number): { webgl: WebGLConfig; webgpu: WebGpuInfo } {
  const candidates = GPU_PRESETS.filter((g) => g.os === os)
  const gpu: GpuPreset = candidates.length ? pick(rng, candidates) : pick(rng, GPU_PRESETS)
  return {
    webgl: {
      enabled: true,
      blockWebgl: false,
      vendor: gpu.vendor,
      renderer: gpu.renderer,
      useRealGPU: false,
      extensions: gpu.extensions.slice(),
      parameters: { ...gpu.parameters },
      version: gpu.webglVersion,
      shadingLanguageVersion: gpu.shadingLanguageVersion
    },
    webgpu: webgpuFor(gpu)
  }
}

function buildHardware(os: OsPlatform, rng: () => number): HardwareConfig {
  return {
    hardwareConcurrency: pick(rng, HARDWARE_CONCURRENCY),
    deviceMemory: pick(rng, DEVICE_MEMORY),
    maxTouchPoints: 0,
    platform: os === 'macOS' ? 'macOS' : 'Win32',
    cpuArchitecture: os === 'macOS' ? 'arm' : 'x86',
    bitness: '64',
    deviceModel: ''
  }
}

function buildLanguage(rng: () => number, locale?: string): LanguageConfig {
  const preset = locale
    ? (LANGUAGE_PRESETS.find((l) => l.locale === locale) ?? pick(rng, LANGUAGE_PRESETS))
    : pick(rng, LANGUAGE_PRESETS)
  const languages = sanitizeLanguageTags(preset.languages)
  // acceptLanguage 必须由列表推导：内核也是这么算的，
  // 手写一个带 q 的头会让「配置 / 页面 / 线上请求头」三处对不上。
  return { acceptLanguage: generateAcceptLanguage(languages), languages, intlLocale: preset.locale }
}

function buildTimezone(rng: () => number, tz?: string): TimezoneConfig {
  const id = tz && TIMEZONES.includes(tz) ? tz : pick(rng, TIMEZONES)
  return { id, offsetMinutes: tzOffsetMinutes(id) }
}

/**
 * 权限查询表。
 *
 * 真实 Chrome 的默认状态是 'default'（还没问过），只有用户点过允许/屏蔽才变
 * granted/denied。之前硬编码 notifications => 'denied' 是个明显的异常信号：
 * 一个从没弹过权限弹窗却已经 denied 的设备，Google 会直接标记。
 *
 * 这里默认全部 default，只把 geolocation 按配置里的 permission 映射（因为
 * 注入层本来就在覆盖地理位置，状态必须与之一致，否则 query 与 getCurrentPosition
 * 互相打脸）。
 */
function buildPermissions(rng: () => number, os: OsPlatform): PermissionsConfig {
  void rng
  void os
  return {
    fallback: 'default',
    entries: {
      geolocation: 'prompt',
      // 剪贴板在真实 Chrome 里读需要授权，写不需要；查询默认未决定
      'clipboard-read': 'default',
      'clipboard-write': 'granted',
      notifications: 'default'
    },
    enforceKnownNames: true
  }
}

/**
 * 虚拟认证器参数。
 *
 * AAGUID 标识的是「哪一款认证器」。真实设备上常见的是平台认证器
 * （Apple Secure Enclave / Windows Hello），它们的 AAGUID 是固定的产品 ID；
 * 用随机 AAGUID 反而更可疑 —— 站点会看到一堆没见过的认证器型号。
 * 所以这里从已知型号表里按 OS 选一个，同一 seed 下稳定复现。
 */
function buildWebAuthn(rng: () => number, os: OsPlatform): WebAuthnConfig {
  // 已知且常见的 AAGUID：Apple（平台）、Windows Hello、Yubico（漫游密钥）
  const apple = '00000000-0000-4000-a000-000050000000'
  const windows = '08987058-cadc-4b81-b6e1-30de50dcbe96'
  const yubico = 'ebbc0223-4b6b-4b4a-9b7f-20d53f46a356'
  const platform = os === 'macOS' || os === 'iOS' ? apple : windows
  // 多数真实用户用的是平台认证器（Touch ID / Windows Hello），
  // 少数挂安全密钥 —— 按 seed 稳定地让约 15% 走 roaming，避免全体一致。
  const roaming = rng() < 0.15
  const aaguid = roaming ? yubico : platform
  const model = roaming
    ? 'YubiKey 5C'
    : os === 'macOS'
      ? 'Touch ID'
      : os === 'iOS'
        ? 'Face ID'
        : 'Windows Hello'
  return {
    enabled: true,
    aaguid,
    model,
    transport: roaming ? 'usb' : 'internal',
    // passkey 登录要求可发现凭证；安全密钥也普遍支持 resident key
    hasResidentKey: true,
    hasUserVerification: true,
    // Apple/Google 的平台 passkey 是云同步的；YubiKey 不是
    isSynced: !roaming,
    supportsLargeBlob: true,
    credProtect: 3
  }
}

/**
 * 自动化痕迹与冷门 API 的默认值。
 *
 * 语言相关的语音列表按 profile 的 locale 选：真实设备上 getVoices() 一定包含
 * 系统语言对应的语音，若 profile 声明 zh-CN 却只返回英文语音会显得不一致。
 */
function buildStealth(rng: () => number, os: OsPlatform, locale: string): StealthConfig {
  const pool = os === 'Windows' ? WINDOWS_VOICES : MAC_VOICES
  const langBase = (locale || 'en-US').split('-')[0]
  // 优先把匹配 profile 语言的语音排在前面，并让第一个成为 default
  const ordered = [...pool].sort((a, b) => {
    const am = a.lang.split('-')[0] === langBase ? 0 : 1
    const bm = b.lang.split('-')[0] === langBase ? 0 : 1
    return am - bm
  })
  const voices = ordered.map((v, i) => ({
    name: v.name,
    lang: v.lang,
    voiceURI: v.voiceURI,
    localService: true,
    default: i === 0
  }))
  // 深色模式在真实用户里占相当比例；按 seed 稳定地让约 35% 走 dark
  const dark = rng() < 0.35
  return {
    enabled: true,
    hideAutomationProps: true,
    chromeObject: true,
    forceVisible: true,
    colorScheme: dark ? 'dark' : 'light',
    prefersReducedMotion: false,
    prefersContrast: 'no-preference',
    forcedColors: 'none',
    displayMode: 'browser',
    pointer: 'fine',
    hover: 'hover',
    anyHover: 'hover',
    update: 'fast',
    voices,
    payment: { enabled: true, canMakePayments: false },
    // 正式版 Chrome 有 H.264 / AAC；Chromium 快照没有 —— 这也是优先用正式版 Chrome 的原因
    codecs: { h264: true, vp9: true, av1: true, aac: true, mp3: true, opus: true, vp8: true },
    consoleHardening: true
  }
}

/**
 * 补齐旧 profile 里缺失的指纹分段。
 *
 * 指纹配置是整块 JSON 存在 fingerprints.config 里的，新增分段后老环境读出来
 * 会缺字段 —— 补丁脚本里任何一处 CFG.xxx.yyy 都会抛 TypeError，
 * 而那种错误在注入阶段是静默的，最后表现为「某项指纹莫名没生效」。
 * 所以所有读取入口都先过一遍这个函数。
 */
export function normalizeFingerprint(fp: FingerprintConfig): FingerprintConfig {
  const fresh = generateFingerprint({ seed: fp?.seed || makeSeed() })
  // 逐段合并只能按 unknown 处理：FingerprintConfig 的键类型是各段的具体类型，
  // 直接赋值会被 TS 收窄成 never。
  const target = { ...fresh, ...fp } as unknown as Record<string, unknown>
  const base = fresh as unknown as Record<string, unknown>
  for (const key of Object.keys(base)) {
    const b = base[key]
    const cur = target[key]
    if (cur === null || cur === undefined) {
      // 整段缺失：直接用默认值
      target[key] = b
    } else if (typeof b === 'object' && b !== null && !Array.isArray(b) && typeof cur === 'object' && !Array.isArray(cur)) {
      // 整段存在但内部缺字段：逐段浅合并，保留用户已改的值
      target[key] = { ...(b as object), ...(cur as object) }
    }
  }
  return target as unknown as FingerprintConfig
}

export function generateFingerprint(options: GenerateOptions = {}): FingerprintConfig {
  const seed = options.seed ?? makeSeed()
  const rng = createRng(seed)
  const os: OsPlatform = options.os ?? 'macOS'
  const kernel = options.kernelVersion
    ? { major: Number(options.kernelVersion.split('.')[0]), full: options.kernelVersion }
    : pick(rng, CHROME_VERSIONS)

  const timezone = buildTimezone(rng, options.ip?.timezone ?? options.timezone)
  const language = buildLanguage(rng, options.locale)
  const fonts = os === 'macOS' ? MAC_FONTS : WINDOWS_FONTS
  const cameraLabel = os === 'macOS' ? 'FaceTime HD Camera (Built-in)' : 'Integrated Camera'
  const micLabel = os === 'macOS' ? 'MacBook Pro Microphone (Built-in)' : 'Microphone (Realtek Audio)'
  const speakerLabel = os === 'macOS' ? 'MacBook Pro Speakers (Built-in)' : 'Speakers (Realtek Audio)'
  const groupId = hex(rng, 24)
  // 显卡预设一次选出：WebGL 与 WebGPU 必须描述同一块 GPU
  const gpu = buildGpu(os, rng)

  return {
    version: 1,
    seed,
    kernel: 'chromium',
    mode: options.mode ?? 'auto',
    ua: buildUa(os, kernel.full, kernel.major),
    clientHints: buildClientHints(os, kernel.full, kernel.major, rng),
    screen: buildScreen(os, rng),
    webgl: gpu.webgl,
    webgpu: {
      enabled: true,
      vendor: gpu.webgpu.vendor,
      architecture: gpu.webgpu.architecture,
      device: gpu.webgpu.device,
      description: gpu.webgpu.description,
      powerPreference: 'high-performance'
    },
    canvas: {
      mode: 'seeded',
      noiseFactor: randInt(rng, 1, 2),
      seed: `${seed}|canvas`,
      textMetricsNoise: true,
      toDataURLNoise: true
    },
    audio: {
      mode: 'seeded',
      noiseFactor: 0.00012,
      seed: `${seed}|audio`,
      sampleRate: 48000,
      channelCount: 2,
      numberOfChannels: 2,
      offlineNoise: true
    },
    fonts: { mode: 'os_default', families: fonts.slice(), seed: `${seed}|fonts` },
    webrtc: {
      mode: 'fake',
      maskLocalIps: true,
      localIps: [
        `192.168.${randInt(rng, 0, 254)}.${randInt(rng, 1, 254)}`,
        `10.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`
      ],
      publicIp: options.ip?.ip ?? '',
      nonProxiedUdp: false
    },
    geolocation: {
      enabled: true,
      permission: 'ask',
      latitude: 0,
      longitude: 0,
      accuracy: 65,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      timezoneId: timezone.id
    },
    mediaDevices: {
      enabled: true,
      devices: [
        { kind: 'videoinput', label: cameraLabel, deviceId: hex(rng, 40), groupId },
        { kind: 'audioinput', label: micLabel, deviceId: hex(rng, 40), groupId },
        { kind: 'audiooutput', label: speakerLabel, deviceId: hex(rng, 40), groupId }
      ]
    },
    battery: { enabled: true, charging: true, chargingTime: 0, dischargingTime: -1, level: 1 },
    hardware: buildHardware(os, rng),
    timezone,
    language,
    headers: {
      extra: {},
      secFetchSite: 'none',
      secFetchMode: 'navigate',
      secFetchDest: 'document',
      acceptEncoding: 'gzip, deflate, br, zstd',
      // 与真实 Chrome 线上 Accept 头逐字对齐（含 signed-exchange 后缀）。
      // 检测页会把「配置值」与「内核实际发出的头」比对，这里少一段就是穿帮。
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
    },
    storage: {
      quota: randInt(rng, 10, 60) * 1024 * 1024 * 1024,
      usage: randInt(rng, 20, 400) * 1024 * 1024,
      persistent: false
    },
    connection: {
      enabled: true,
      effectiveType: '4g',
      rtt: randInt(rng, 40, 160),
      downlink: Number((rng() * 8 + 4).toFixed(2)),
      saveData: false,
      type: ''
    },
    privacy: { dnt: false, gpc: false },
    plugins: { mode: 'chrome_default', plugins: [], mimeTypes: [] },
    permissions: buildPermissions(rng, os),
    stealth: buildStealth(rng, os, language.intlLocale),
    machine: {
      macAddress: `02:${hex(rng, 2)}:${hex(rng, 2)}:${hex(rng, 2)}:${hex(rng, 2)}:${hex(rng, 2)}`.toUpperCase(),
      machineId: hex(rng, 32),
      serialNumber: hex(rng, 12).toUpperCase(),
      hostname: `${os === 'macOS' ? 'Mac' : 'PC'}-${hex(rng, 4).toUpperCase()}`,
      deviceId: hex(rng, 16),
      diskSerial: hex(rng, 16).toUpperCase()
    },
    webauthn: buildWebAuthn(rng, os),
    performance: {
      jitterEnabled: true,
      performanceNowJitter: 0,
      memoryEnabled: true,
      jsHeapSizeLimit: 4294705152,
      totalJSHeapSize: randInt(rng, 2_500_000, 6_500_000),
      usedJSHeapSize: randInt(rng, 1_500_000, 4_000_000)
    },
    launch: {
      args: [],
      disableFeatures: [],
      enableFeatures: [],
      bypassCSP: false,
      ignoreCertificateErrors: false
    }
  }
}
