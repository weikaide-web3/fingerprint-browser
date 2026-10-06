import type { CookieRecord, ExpireAction, KeyPreset, SessionRetention } from '@shared/session'
import { DEFAULT_RETENTION } from '@shared/session'

/**
 * 登录态保留策略的纯逻辑（不碰内核、不碰磁盘，便于单测）。
 *
 * 关键键保护的意义：用户点「清理登录态」时，Google 的 SID/SAPISID 与
 * X 的 twid/ct0/gt 必须活下来 —— 它们丢了，账号立刻被判定为新设备，
 * 之前养的设备信任全部作废。
 */

/** 支持 * 通配的键名匹配（大小写不敏感，因为 cookie 名大小写在不同站点不一致） */
export function matchesKey(name: string, patterns: string[]): boolean {
  const n = String(name ?? '').toLowerCase()
  for (const raw of patterns) {
    const p = String(raw ?? '').trim().toLowerCase()
    if (!p) continue
    if (!p.includes('*')) {
      if (n === p) return true
      continue
    }
    // 把通配模式转成正则，其它字符全部转义，避免用户写 . 时被当成正则元字符
    const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    if (re.test(n)) return true
  }
  return false
}

export interface CookiePartition {
  keep: CookieRecord[]
  remove: CookieRecord[]
}

export function partitionCookies(cookies: CookieRecord[], protectedKeys: string[]): CookiePartition {
  if (!protectedKeys.length) return { keep: [], remove: cookies }
  const keep: CookieRecord[] = []
  const remove: CookieRecord[] = []
  for (const c of cookies) (matchesKey(c.name, protectedKeys) ? keep : remove).push(c)
  return { keep, remove }
}

export interface StoragePartition {
  keep: { name: string; value: string }[]
  remove: { name: string; value: string }[]
}

export function partitionLocalStorage(items: { name: string; value: string }[], protectedKeys: string[]): StoragePartition {
  if (!protectedKeys.length) return { keep: [], remove: items }
  const keep: { name: string; value: string }[] = []
  const remove: { name: string; value: string }[] = []
  for (const it of items) (matchesKey(it.name, protectedKeys) ? keep : remove).push(it)
  return { keep, remove }
}

/** 归一化用户输入的策略：非法值退回默认，避免脏数据让清理逻辑崩掉 */
export function normalizeRetention(input: Partial<SessionRetention> | null | undefined): SessionRetention {
  const days = input?.maxAgeDays
  const maxAgeDays = days === null || days === undefined ? null : Math.max(0, Math.floor(Number(days)))
  const onExpire: ExpireAction = (['keep', 'clear_cookies', 'clear_all'] as ExpireAction[]).includes(input?.onExpire as ExpireAction)
    ? (input?.onExpire as ExpireAction)
    : DEFAULT_RETENTION.onExpire
  const protectedKeys = Array.isArray(input?.protectedKeys)
    ? [...new Set(input!.protectedKeys!.map((k) => String(k).trim()).filter(Boolean))]
    : []
  return { maxAgeDays: Number.isFinite(maxAgeDays as number) || maxAgeDays === null ? maxAgeDays : null, onExpire, protectedKeys }
}

export interface RetentionDecision {
  expired: boolean
  /** 登录态已使用天数（以最后打开时间为基准） */
  ageDays: number
  /** 到期且动作不是 keep 时才清理 */
  action: ExpireAction
  /** 距离到期还有多少天（null = 永不过期） */
  daysLeft: number | null
}

/**
 * 判断登录态是否过期。
 * 年龄基准取 lastOpenedAt：账号信任是靠「持续使用」维持的，
 * 一个从没打开过的环境不该因为创建时间太久而被清掉。
 */
export function decideRetention(r: SessionRetention, lastUsedAt: number | null, createdAt: number, at = Date.now()): RetentionDecision {
  const base = lastUsedAt ?? createdAt
  const ageDays = Math.floor((at - base) / 86400000)
  if (r.maxAgeDays === null) return { expired: false, ageDays, action: 'keep', daysLeft: null }
  const daysLeft = r.maxAgeDays - ageDays
  return { expired: daysLeft <= 0, ageDays, action: daysLeft <= 0 ? r.onExpire : 'keep', daysLeft }
}

/**
 * 内置关键键预设。
 * 只列「删掉就会破坏设备连续性」的键，普通统计 cookie（_ga、_gid 等）故意不保护 ——
 * 它们删了无害，反而保留全部 cookie 会让「清理」这个操作失去意义。
 */
export const KEY_PRESETS: KeyPreset[] = [
  {
    id: 'google',
    label: 'Google 账号',
    description: 'SID / SAPISID / __Secure-1PSID* 是登录态本体，__Secure-1PSIDTS 的轮换节奏被用来判断设备是否连续使用',
    cookieKeys: [
      'sid',
      '__secure-1psid',
      '__secure-1psidts',
      '__secure-1psidcc',
      '__secure-3psid',
      '__sid',
      'hsid',
      'ssid',
      'apisid',
      'sapisid',
      'ssid',
      'nid',
      'consent',
      'cgic',
      'dn',
      'otz'
    ],
    storageKeys: ['g_state', 'g_user_language', 'accountchooser.*']
  },
  {
    id: 'x',
    label: 'X / Twitter',
    description: 'twid + ct0 是会话与 CSRF 配对，gt（localStorage）与 __cuid 是设备锚点；丢一个就变新设备',
    cookieKeys: ['twid', 'ct0', '__cuid', 'guest_id', 'gt', 'tdid', 'lang', '__cf_bm'],
    storageKeys: ['gt', 'tdid', 'com.x.*']
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare 盾',
    description: '__cf_bm / cf_clearance 与 TLS 指纹绑定，清掉后下次访问会重新排队过盾',
    cookieKeys: ['__cf_bm', 'cf_clearance', '_cfuvid'],
    storageKeys: []
  },
  {
    id: 'common',
    label: '通用必要项',
    description: '语言 / 同意状态 / CSRF，清掉后页面会退回默认语言并重新弹 consent',
    cookieKeys: ['lang', 'consent', 'csrf_token', '_csrf', 'session_id'],
    storageKeys: ['consent', 'cookie-consent', 'i18nextLng']
  }
]

export function presetKeys(ids: string[]): string[] {
  const out = new Set<string>()
  for (const p of KEY_PRESETS) {
    if (!ids.includes(p.id)) continue
    for (const k of p.cookieKeys) out.add(k)
    for (const k of p.storageKeys) out.add(k)
  }
  return [...out]
}