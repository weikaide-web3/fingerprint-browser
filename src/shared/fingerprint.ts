/**
 * 指纹配置契约（对标 AdsPower / MoreLogin 可配置指纹项）。
 * 主进程与渲染进程共用。
 */

import type { WebAuthnConfig } from './webauthn'

export type Kernel = 'chromium' | 'firefox'
export type FingerprintMode = 'auto' | 'sync_ip' | 'custom' | 'clone'

export type OsPlatform = 'macOS' | 'Windows' | 'Linux' | 'Android' | 'iOS'
export type BrowserBrand = 'Chrome' | 'Edge' | 'Firefox' | 'Safari'

/** 1. User-Agent */
export interface UaConfig {
  ua: string
  browser: BrowserBrand
  version: string
  major: number
  os: OsPlatform
  osVersion: string
  mobile: boolean
}

/** 2. Client Hints (sec-ch-ua*) —— 必须与 UA 严格一致 */
export interface ClientHintsConfig {
  enabled: boolean
  brands: { brand: string; version: string }[]
  fullVersionList: { brand: string; version: string }[]
  platform: string
  platformVersion: string
  architecture: string
  bitness: string
  model: string
  formFactors: string[]
  mobile: boolean
  uaFullVersion: string
  wow64: boolean
}

/** 3. 屏幕 / 窗口 */
export interface ScreenConfig {
  width: number
  height: number
  availWidth: number
  availHeight: number
  availLeft: number
  availTop: number
  colorDepth: number
  pixelDepth: number
  devicePixelRatio: number
  orientationType: string
  orientationAngle: number
  monitors: {
    x: number
    y: number
    width: number
    height: number
    scaleFactor: number
    isDefault: boolean
  }[]
  windowWidth: number
  windowHeight: number
}

/** 4. WebGL */
export interface WebGLConfig {
  enabled: boolean
  blockWebgl: boolean
  vendor: string
  renderer: string
  useRealGPU: boolean
  extensions: string[]
  /** WebGL getParameter 覆盖表（枚举名 -> 值） */
  parameters: Record<string, string | number>
  version: string
  shadingLanguageVersion: string
}

/** 5. WebGPU */
export interface WebGPUConfig {
  enabled: boolean
  vendor: string
  architecture: string
  device: string
  description: string
  powerPreference: string
}

/** 6. Canvas 指纹 */
export interface CanvasConfig {
  mode: 'off' | 'noise' | 'seeded'
  noiseFactor: number
  seed: string
  textMetricsNoise: boolean
  toDataURLNoise: boolean
}

/** 7. AudioContext 指纹 */
export interface AudioConfig {
  mode: 'off' | 'noise' | 'seeded'
  noiseFactor: number
  seed: string
  sampleRate: number
  channelCount: number
  numberOfChannels: number
  offlineNoise: boolean
}

/** 8. 字体 */
export interface FontsConfig {
  mode: 'os_default' | 'custom' | 'random'
  families: string[]
  seed: string
}

/** 9. WebRTC 泄漏控制 */
export interface WebRTCConfig {
  mode: 'disable' | 'fake' | 'real'
  maskLocalIps: boolean
  localIps: string[]
  publicIp: string
  nonProxiedUdp: boolean
}

/** 10. Geolocation */
export interface GeolocationConfig {
  enabled: boolean
  permission: 'ask' | 'allow' | 'block'
  latitude: number
  longitude: number
  accuracy: number
  altitude: number | null
  altitudeAccuracy: number | null
  heading: number | null
  speed: number | null
  timezoneId: string
}

/** 11. MediaDevices */
export interface MediaDeviceItem {
  kind: 'videoinput' | 'audioinput' | 'audiooutput'
  label: string
  deviceId: string
  groupId: string
}
export interface MediaDevicesConfig {
  enabled: boolean
  devices: MediaDeviceItem[]
}

/** 12. Battery Status */
export interface BatteryConfig {
  enabled: boolean
  charging: boolean
  chargingTime: number
  dischargingTime: number
  level: number
}

/** 13. 硬件规格 */
export interface HardwareConfig {
  hardwareConcurrency: number
  deviceMemory: number
  maxTouchPoints: number
  platform: string
  cpuArchitecture: string
  bitness: string
  deviceModel: string
}

/** 14. 时区（Intl 与 Date.getTimezoneOffset 必须一致） */
export interface TimezoneConfig {
  id: string
  offsetMinutes: number
}

/** 15. 语言 */
export interface LanguageConfig {
  acceptLanguage: string
  languages: string[]
  intlLocale: string
}

/** 16. HTTP 请求头 */
export interface HeadersConfig {
  extra: Record<string, string>
  secFetchSite: string
  secFetchMode: string
  secFetchDest: string
  acceptEncoding: string
  accept: string
}

/** 17. 存储配额 navigator.storage.estimate() */
export interface StorageConfig {
  quota: number
  usage: number
  persistent: boolean
}

/** 18. Network Information */
export interface ConnectionConfig {
  enabled: boolean
  effectiveType: 'slow-2g' | '2g' | '3g' | '4g'
  rtt: number
  downlink: number
  saveData: boolean
  type: string
}

/** 19. Do Not Track / GPC */
export interface PrivacySignalConfig {
  dnt: boolean
  gpc: boolean
}

/** 20. 插件 / MIME */
export interface PluginsConfig {
  mode: 'chrome_default' | 'custom'
  plugins: { name: string; description: string; filename: string }[]
  mimeTypes: { type: string; suffixes: string; description: string }[]
}

/** 21. 机器级标识（配套 App 读取，浏览器内不可见） */
export interface MachineConfig {
  macAddress: string
  machineId: string
  serialNumber: string
  hostname: string
  deviceId: string
  diskSerial: string
}

/** 21b. WebAuthn / Passkey 虚拟认证器（契约见 shared/webauthn.ts） */

/** 22. 时间与性能抖动 */
export interface PerformanceConfig {
  jitterEnabled: boolean
  performanceNowJitter: number
  memoryEnabled: boolean
  jsHeapSizeLimit: number
  totalJSHeapSize: number
  usedJSHeapSize: number
}

/** 23. 启动参数 / 内核开关 */
export interface LaunchConfig {
  args: string[]
  disableFeatures: string[]
  enableFeatures: string[]
  bypassCSP: boolean
  ignoreCertificateErrors: boolean
}

/** 权限查询（Permissions API）
 *
 * 'prompt' 是 Chrome 对 geolocation / camera 等「会弹窗」权限在未决定时的真实返回值，
 * 'default' 则是 notifications / clipboard-read 等权限的未决定状态 —— 两者不能混用。
 */
export type PermissionState = 'default' | 'granted' | 'denied' | 'prompt'

export interface PermissionsConfig {
  /**
   * 未在 entries 里列出的权限返回什么。
   * 真实 Chrome 首次访问任何权限都是 'default'（弹窗询问过之后才变 granted/denied），
   * 所以默认必须是 default —— 一上来就 denied 等于告诉站点「这台设备从没问过权限」。
   */
  fallback: PermissionState
  /** 权限名 -> 状态。键用 Permissions API 的标准 name（clipboard-read / geolocation ...） */
  entries: Record<string, PermissionState>
  /**
   * 查询未知权限名时是否按真实 Chrome 的行为 reject TypeError。
   * 关掉它会让「查一个不存在的权限」返回对象而不是报错 —— 一眼假。
   */
  enforceKnownNames: boolean
}

/**
 * 自动化痕迹与「真实浏览器应有但自动化环境常缺」的信号。
 *
 * 这一组不是「伪装成别人」，而是「别露出自己是被驱动的」：
 * ChromeDriver / Playwright / CDP 会在 window 上留下 cdc_ 之类的属性，
 * headless 下 visibilityState 与 hasFocus 和真人不同，
 * matchMedia / speechSynthesis / PaymentRequest 这些冷门 API 缺失本身就是特征。
 */
export interface StealthConfig {
  enabled: boolean
  /** 删除 window 上 cdc_ / dc_ / webdriver 相关的自动化残留 */
  hideAutomationProps: boolean
  /** 补全 window.chrome（csi / loadTimes / app / runtime） */
  chromeObject: boolean
  /** 强制呈现「前台可见且聚焦」，抵消 headless / 后台窗口的差异 */
  forceVisible: boolean
  /** prefers-color-scheme */
  colorScheme: 'light' | 'dark' | 'system'
  prefersReducedMotion: boolean
  prefersContrast: 'no-preference' | 'more' | 'less' | 'custom'
  forcedColors: 'none' | 'forced'
  /** display-mode：普通标签页是 browser，PWA 安装后才是 standalone */
  displayMode: 'browser' | 'minimal-ui' | 'standalone' | 'fullscreen'
  pointer: 'none' | 'coarse' | 'fine'
  hover: 'none' | 'hover'
  anyHover: 'none' | 'hover'
  update: 'slow' | 'fast'
  /** speechSynthesis.getVoices()：缺失或为空是 headless 常见特征 */
  voices: { name: string; lang: string; localService: boolean; default: boolean; voiceURI: string }[]
  /** PaymentRequest.canMakePayments()：Google 用它验证「真实 Chrome + 可用支付能力」 */
  payment: { enabled: boolean; canMakePayments: boolean }
  /** MediaCapabilities.decodingInfo()：真实解码能力（缺 H.264 一眼是 Chromium 快照） */
  codecs: { h264: boolean; vp9: boolean; av1: boolean; aac: boolean; mp3: boolean; opus: boolean; vp8: boolean }
  /**
   * console 加固：CDP 的 Runtime.enable 会让 console.log(obj) 去序列化对象，
   * 从而触发对象上的 getter —— 站点正是用这个技巧判断「有没有调试器挂着」。
   * 开启后先把参数自行转成字符串再交给原生方法，getter 就不会被触发。
   */
  consoleHardening: boolean
}

/** 指纹总配置 */
export interface FingerprintConfig {
  version: number
  seed: string
  kernel: Kernel
  mode: FingerprintMode
  ua: UaConfig
  clientHints: ClientHintsConfig
  screen: ScreenConfig
  webgl: WebGLConfig
  webgpu: WebGPUConfig
  canvas: CanvasConfig
  audio: AudioConfig
  fonts: FontsConfig
  webrtc: WebRTCConfig
  geolocation: GeolocationConfig
  mediaDevices: MediaDevicesConfig
  battery: BatteryConfig
  hardware: HardwareConfig
  timezone: TimezoneConfig
  language: LanguageConfig
  headers: HeadersConfig
  storage: StorageConfig
  connection: ConnectionConfig
  privacy: PrivacySignalConfig
  plugins: PluginsConfig
  permissions: PermissionsConfig
  stealth: StealthConfig
  machine: MachineConfig
  webauthn: WebAuthnConfig
  performance: PerformanceConfig
  launch: LaunchConfig
}

/** 一致性校验问题 */
export interface ConsistencyIssue {
  level: 'error' | 'warn' | 'info'
  code: string
  message: string
  fields: string[]
}

/** 一致性体检结果：score = 100 - 12*error - 4*warn - 1*info，下限 0 */
export interface ConsistencyReport {
  issues: ConsistencyIssue[]
  /** 0-100，100 = 没有任何已知矛盾 */
  score: number
  errors: number
  warns: number
  infos: number
}
