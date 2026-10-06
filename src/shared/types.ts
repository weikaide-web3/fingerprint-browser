import type { FingerprintConfig, FingerprintMode, Kernel, OsPlatform } from './fingerprint'
import type { SessionPolicy, SessionRetention } from './session'

export type * from './fingerprint'
export type * from './session'
export type * from './detect'
export type * from './settings'
export type * from './http'
export type * from './humanize'
export type * from './account'
export type * from './webauthn'
export type * from './association'
export type * from './api'
export type * from './rpa'

export type ProxyMode = 'bind' | 'none'
export type ProfileStatus = 'stopped' | 'starting' | 'running' | 'error'
/** 出口 IP 的质量分类（与 proxy/checker.ts 的 IpQuality 对齐） */
export type IpQualityLabel = 'residential' | 'mobile' | 'datacenter' | 'anonymizer' | 'unknown'

export interface ExtensionRecord {
  id: string
  name: string
  path: string
  version: string | null
  enabled: boolean
  /** manifest.json 中声明的权限列表 */
  permissions: string[]
  /** manifest 的 description */
  description: string | null
  createdAt: number
  /** 软删除时间戳（非空即在回收站） */
  deletedAt?: number | null
  /** 来源：解包目录 或 Chrome 应用商店 */
  source?: 'unpacked' | 'store'
  /** Chrome 应用商店扩展 ID（source=store 时有值） */
  storeId?: string | null
}

export interface ExtensionBinding {
  extensionId: string
  profileId: string
}

export interface Group {
  id: string
  name: string
  color: string | null
  sortOrder: number
  createdAt: number
}

export interface Tag {
  id: string
  name: string
  color: string | null
  createdAt: number
}

export interface ProxyRecord {
  id: string
  name: string
  scheme: 'http' | 'https' | 'socks5' | 'socks5h' | 'socks4'
  host: string
  port: number
  username: string | null
  hasPassword: boolean
  groupId: string | null
  ip: string | null
  country: string | null
  region: string | null
  city: string | null
  isp: string | null
  timezone: string | null
  /** 出口质量：机房 / 匿名代理出口在 Google、X 都是一票否决 */
  quality: IpQualityLabel | null
  qualityScore: number | null
  qualityIssues: string[]
  asn: string | null
  asName: string | null
  org: string | null
  reverse: string | null
  usageType: string | null
  hosting: boolean
  /** 出口被标记为匿名代理 / VPN */
  proxyExit: boolean
  mobile: boolean
  anycast: boolean
  latencyMs: number | null
  lastCheckedAt: number | null
  checkedOk: number | null
  createdAt: number
  updatedAt: number
  /** 软删除时间戳（非空即在回收站） */
  deletedAt?: number | null
}

export interface ProxyInput {
  id?: string
  name?: string
  scheme: 'http' | 'https' | 'socks5' | 'socks5h' | 'socks4'
  host: string
  port: number
  username?: string | null
  password?: string | null
  groupId?: string | null
}

export interface Profile {
  id: string
  name: string
  groupId: string | null
  color: string | null
  icon: string | null
  note: string | null
  kernel: Kernel
  fingerprintMode: FingerprintMode
  proxyMode: ProxyMode
  proxyId: string | null
  userDataDir: string
  startupUrls: string[]
  launchArgs: string[]
  sessionPolicy: SessionPolicy
  /** 账号维度的登录态保留策略（永不清理 / 保留 N 天 / 关键键保护） */
  retention: SessionRetention
  archived: number
  status: ProfileStatus
  openCount: number
  lastOpenedAt: number | null
  createdAt: number
  updatedAt: number
  /** 软删除时间戳（非空即在回收站） */
  deletedAt?: number | null
  tags: string[]
  fingerprint: FingerprintConfig | null
  proxy: ProxyRecord | null
}

export interface ProfileListItem extends Profile {}

export interface ProfileInput {
  id?: string
  name: string
  groupId?: string | null
  color?: string | null
  icon?: string | null
  note?: string | null
  kernel?: Kernel
  fingerprintMode?: FingerprintMode
  proxyMode?: ProxyMode
  proxyId?: string | null
  startupUrls?: string[]
  launchArgs?: string[]
  sessionPolicy?: SessionPolicy
  /** 账号维度的登录态保留策略 */
  retention?: SessionRetention
  tags?: string[]
  fingerprint?: FingerprintConfig | null
  /** 从其它 profile 克隆 */
  cloneFrom?: string | null
  /** 新建时自动生成指纹的参数 */
  fingerprintOptions?: {
    os?: OsPlatform
    locale?: string
    timezone?: string
    seed?: string
  }
}

export interface ProfileFilter {
  search?: string
  groupId?: string | null
  tags?: string[]
  includeArchived?: boolean
  sort?: 'created_at' | 'name' | 'last_opened_at' | 'open_count'
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface ListResult<T> {
  items: T[]
  total: number
}

export interface SettingsMap {
  [key: string]: string | number | boolean | null
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  arch: string
  dataDir: string
  profilesDir: string
  apiBaseUrl: string | null
  /**
   * 机密加密状态。
   * safeStorage（macOS 钥匙串）不可用时，账号密码 / 代理密码 / passkey 私钥
   * 会以 plain: 前缀明文落库。这个状态过去是静默的，用户完全看不出来。
   */
  encryption: {
    available: boolean
    plaintextStored: boolean
    message: string | null
  }
}

export interface BrowserLaunchResult {
  profileId: string
  wsEndpoint: string
  httpEndpoint: string
  pid: number
  startedAt: number
}

export interface StatusEvent {
  profileId: string
  status: ProfileStatus
  pid?: number
  wsEndpoint?: string
  message?: string
}

export interface LogEvent {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  meta?: Record<string, unknown>
}
