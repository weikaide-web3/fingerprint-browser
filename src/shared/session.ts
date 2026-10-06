/** Cookie / 会话模块的共用契约（主进程与渲染进程都依赖） */

export type CookieFormat = 'auto' | 'netscape' | 'playwright'
/** 关闭环境时对登录态的处理策略 */
export type SessionPolicy = 'keep' | 'clear_cookies' | 'clear_all'
/** 磁盘清理的目标 */
export type CleanupTarget = 'cache' | 'cookies' | 'session'
/** 登录态到期后的动作 */
export type ExpireAction = 'keep' | 'clear_cookies' | 'clear_all'

/**
 * 账号维度的登录态保留策略。
 *
 * 为什么需要它：Google 与 X 都把「登录态是否连续」当作设备信任的核心信号 ——
 * SID/SAPISID/__Secure-1PSIDTS 的轮换节奏、X 的 twid/ct0/gt 持久性一旦断掉，
 * 服务端就把这次访问当成新设备，直接触发手机验证甚至风控标记。
 * 所以「关闭时清空」这种看似干净的做法对已养号的账号是有害的，必须能按账号锁定为永不清理。
 */
export interface SessionRetention {
  /** 登录态最长保留天数；null = 永不清理 */
  maxAgeDays: number | null
  /** 到期后的动作（默认 keep：只提醒，不动数据） */
  onExpire: ExpireAction
  /**
   * 清理时必须保留的关键键（支持 * 通配）。
   * 作用于 cookie 名与 localStorage 名 —— 即使用户手动点「清理登录态」也不会碰它们。
   */
  protectedKeys: string[]
}

export const DEFAULT_RETENTION: SessionRetention = {
  maxAgeDays: null,
  onExpire: 'keep',
  protectedKeys: []
}

/** 关键键预设：按站点给出「删了就等于自曝新设备」的键名 */
export interface KeyPreset {
  id: string
  label: string
  description: string
  cookieKeys: string[]
  storageKeys: string[]
}

export interface CookieRecord {
  name: string
  value: string
  domain: string
  path: string
  /** unix 秒；-1 表示会话级 cookie（关浏览器即失效） */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface OriginStorage {
  origin: string
  localStorage: { name: string; value: string }[]
}

export interface CookieBundle {
  cookies: CookieRecord[]
  origins: OriginStorage[]
}

export interface ParseIssue {
  line: string
  reason: string
}

export interface SessionStats {
  profileId: string
  name: string
  cookieCount: number
  sizeBytes: number
  storageStatePath: string | null
  updatedAt: number | null
  running: boolean
  policy: SessionPolicy
  lastOpenedAt: number | null
  /** 账号维度的保留策略 */
  retention: SessionRetention
  /** 登录态已使用天数（以最后打开时间为基准） */
  ageDays: number
  /** 距到期剩余天数；null = 永不过期 */
  daysLeft: number | null
  protectedKeyCount: number
}

export interface ExportResult {
  format: Exclude<CookieFormat, 'auto'>
  filename: string
  content: string
  cookieCount: number
  originCount: number
  localStorageKeys: number
  /** 主进程同时落了一份快照，UI 可直接定位到它 */
  storagePath: string
}

export interface ImportResult {
  format: Exclude<CookieFormat, 'auto'>
  added: number
  total: number
  origins: number
  issues: ParseIssue[]
}

export interface ClearResult {
  cleared: number
  policy: SessionPolicy
  /** 被关键键保护而保留下来的 cookie 数 */
  kept: number
  keptKeys: string[]
}

export interface CleanupResult {
  target: CleanupTarget
  removed: string[]
  freedBytes: number
  wasRunning: boolean
}

/** 登录态到期提醒（列表页与打开环境时都会用到） */
export interface RetentionAlert {
  profileId: string
  name: string
  ageDays: number
  maxAgeDays: number | null
  daysLeft: number | null
  onExpire: ExpireAction
  /** 已到期：会按 onExpire 处理 */
  expired: boolean
  /** 即将到期：仅提醒 */
  soon: boolean
}
