import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright-core'
import { getSession } from '../browser/registry'
import { withContext } from '../browser/with-context'
import { getProfile, listProfiles, setRetention, setSessionPolicy } from '../db/repositories/profiles'
import { allSessionMeta, getSessionMeta, upsertSessionMeta } from '../db/repositories/sessions'
import { ensureDir, profileCookiesDir, profileUserDataDir } from '../paths'
import { cleanupUserData, userDataSize } from '../session/disk'
import { bundleFilename, normalizeCookie, parseCookies, toNetscape, toStorageState } from '../session/cookies'
import { decideRetention, normalizeRetention, partitionCookies } from '../session/retention'
import { log, logError } from '../lib/log'
import {
  DEFAULT_RETENTION,
  type CleanupResult,
  type CleanupTarget,
  type ClearResult,
  type CookieBundle,
  type CookieFormat,
  type CookieRecord,
  type ExportResult,
  type ImportResult,
  type RetentionAlert,
  type SessionPolicy,
  type SessionRetention,
  type SessionStats
} from '@shared/session'
import type { Profile } from '@shared/types'

/**
 * 会话服务：cookie / localStorage 的导出导入、清理策略与体积统计。
 *
 * 关键点：cookie 的真身在内核的 user-data 里（macOS 下还是加密的），
 * 所以任何读写都必须通过「运行中的内核」进行 —— 环境没开时，
 * 这里会临时以 headless 拉起同一个 profile，读完即关，保证拿到的是同一份登录态。
 */

function requireProfile(profileId: string): Profile {
  const p = getProfile(profileId)
  if (!p) throw new Error(`环境不存在：${profileId}`)
  return p
}

function toCookieRecords(raw: unknown[]): CookieRecord[] {
  const out: CookieRecord[] = []
  for (const c of raw) {
    try {
      out.push(normalizeCookie(c))
    } catch {
      /* 内核返回的异常条目直接丢弃，不影响其余 cookie */
    }
  }
  return out
}

async function readCookies(ctx: BrowserContext): Promise<CookieRecord[]> {
  return toCookieRecords(await ctx.cookies())
}

/** 逐个 origin 打开页面读 localStorage；失败的 origin 记录原因但不中断 */
async function readOrigins(ctx: BrowserContext, origins: string[]): Promise<CookieBundle['origins']> {
  const out: CookieBundle['origins'] = []
  for (const origin of origins) {
    const page = await ctx.newPage()
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 })
      const entries = await page.evaluate(() => {
        const items: { name: string; value: string }[] = []
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i)
          if (k !== null) items.push({ name: k, value: String(localStorage.getItem(k)) })
        }
        return items
      })
      out.push({ origin, localStorage: entries })
    } catch (e) {
      log('session', `读取 ${origin} 的 localStorage 失败：${(e as Error).message}`)
    } finally {
      await page.close().catch(() => undefined)
    }
  }
  return out
}

async function writeOrigins(ctx: BrowserContext, origins: CookieBundle['origins']): Promise<number> {
  let keys = 0
  for (const item of origins) {
    if (!item.localStorage.length) continue
    const page = await ctx.newPage()
    try {
      await page.goto(item.origin, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.evaluate((entries: { name: string; value: string }[]) => {
        for (const e of entries) localStorage.setItem(e.name, e.value)
      }, item.localStorage)
      keys += item.localStorage.length
    } catch (e) {
      logError('session', `写入 ${item.origin} 的 localStorage 失败`, e)
    } finally {
      await page.close().catch(() => undefined)
    }
  }
  return keys
}

/** cookie 里出现过的 https origin，作为 localStorage 的默认采集范围 */
function originsFromCookies(cookies: CookieRecord[]): string[] {
  const set = new Set<string>()
  for (const c of cookies) {
    const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
    if (!host) continue
    set.add(`https://${host}`)
  }
  return [...set]
}

function buildStats(
  profile: Profile,
  meta: { cookie_count: number; storage_state_path: string | null; updated_at: number } | null,
  sizeBytes: number
): SessionStats {
  const retention = profile.retention ?? DEFAULT_RETENTION
  const decision = decideRetention(retention, profile.lastOpenedAt, profile.createdAt)
  return {
    profileId: profile.id,
    name: profile.name,
    cookieCount: meta?.cookie_count ?? 0,
    sizeBytes,
    storageStatePath: meta?.storage_state_path ?? null,
    updatedAt: meta?.updated_at ?? null,
    running: Boolean(getSession(profile.id)),
    policy: profile.sessionPolicy ?? 'keep',
    lastOpenedAt: profile.lastOpenedAt,
    retention,
    ageDays: decision.ageDays,
    daysLeft: decision.daysLeft,
    protectedKeyCount: retention.protectedKeys.length
  }
}

export function stats(profileId: string): SessionStats {
  const profile = requireProfile(profileId)
  const meta = getSessionMeta(profileId)
  return buildStats(profile, meta, meta?.size_bytes || userDataSize(profileId))
}

/** 列表页一次性拿全部环境的登录态概况 */
export function statsAll(): SessionStats[] {
  const metaMap = allSessionMeta()
  return listProfiles({ limit: 500 }).items.map((profile) => {
    const meta = metaMap.get(profile.id)
    return buildStats(profile, meta ?? null, meta?.size_bytes || userDataSize(profile.id))
  })
}

/** 真正读一次内核里的 cookie 数量并落库（打开/关闭环境后调用） */
export async function refreshStats(profileId: string): Promise<SessionStats> {
  const profile = requireProfile(profileId)
  const cookies = await withContext(profileId, '读取登录态', readCookies)
  const size = userDataSize(profileId)
  upsertSessionMeta(profileId, { cookieCount: cookies.length, sizeBytes: size })
  const meta = getSessionMeta(profileId)
  return buildStats(profile, meta ?? { cookie_count: cookies.length, storage_state_path: null, updated_at: Date.now() }, size)
}

export async function exportBundle(
  profileId: string,
  opts: { format?: CookieFormat; includeStorage?: boolean; origins?: string[] } = {}
): Promise<ExportResult> {
  const profile = requireProfile(profileId)
  const bundle = await withContext(profileId, '导出登录态', async (ctx) => {
    const cookies = await readCookies(ctx)
    const origins = opts.includeStorage ? (opts.origins?.length ? opts.origins : originsFromCookies(cookies)) : []
    return { cookies, origins: origins.length ? await readOrigins(ctx, origins) : [] }
  })

  const resolved = opts.format && opts.format !== 'auto' ? opts.format : 'netscape'
  const content = resolved === 'playwright' ? toStorageState(bundle) : toNetscape(bundle.cookies)
  const dir = ensureDir(profileCookiesDir(profileId))
  const snapshotPath = path.join(dir, 'last-export' + (resolved === 'playwright' ? '.json' : '.txt'))
  try {
    fs.writeFileSync(snapshotPath, content, 'utf8')
  } catch (e) {
    logError('session', '写入导出快照失败', e)
  }
  upsertSessionMeta(profileId, {
    cookieCount: bundle.cookies.length,
    sizeBytes: userDataSize(profileId),
    storageStatePath: snapshotPath
  })
  return {
    format: resolved,
    filename: bundleFilename(profile.name, resolved, Date.now()),
    content,
    cookieCount: bundle.cookies.length,
    originCount: bundle.origins.length,
    localStorageKeys: bundle.origins.reduce((n, o) => n + o.localStorage.length, 0),
    storagePath: snapshotPath
  }
}

export async function importBundle(
  profileId: string,
  content: string,
  format: CookieFormat = 'auto'
): Promise<ImportResult> {
  requireProfile(profileId)
  const { format: resolved, bundle, issues } = parseCookies(content, format)
  if (!bundle.cookies.length && !bundle.origins.length) {
    throw new Error(`没有解析到任何登录态${issues.length ? `（首个问题：${issues[0].reason}）` : ''}`)
  }
  const outcome = await withContext(profileId, '导入登录态', async (ctx) => {
    const existing = await readCookies(ctx)
    await ctx.addCookies(
      bundle.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite
      }))
    )
    const after = await readCookies(ctx)
    const storageKeys = bundle.origins.length ? await writeOrigins(ctx, bundle.origins) : 0
    return { added: after.length - existing.length, total: after.length, storageKeys }
  })
  upsertSessionMeta(profileId, { cookieCount: outcome.total, sizeBytes: userDataSize(profileId) })
  return { format: resolved, added: Math.max(outcome.added, 0), total: outcome.total, origins: bundle.origins.length, issues }
}

/**
 * 清理 cookie，但保留被关键键保护的那些。
 *
 * 内核只有 clearCookies() 这种「全清」的接口，所以做法是：
 * 先读出全部 → 挑出受保护的 → 清空 → 把受保护的写回去。
 * 看起来绕，但这是保住 Google SID / X twid 的唯一办法：
 * 一旦这些键被删，账号在服务端就变成新设备，之前养的设备信任全部作废。
 */
export async function clearCookies(profileId: string, opts: { ignoreProtection?: boolean } = {}): Promise<ClearResult> {
  const profile = requireProfile(profileId)
  const protectedKeys = opts.ignoreProtection ? [] : (profile.retention ?? DEFAULT_RETENTION).protectedKeys
  const outcome = await withContext(profileId, '清理登录态', async (ctx) => {
    const before = await readCookies(ctx)
    const { keep, remove } = partitionCookies(before, protectedKeys)
    if (!remove.length) return { cleared: 0, kept: keep.length, keptNames: keep.map((c) => c.name) }
    await ctx.clearCookies()
    if (keep.length) {
      await ctx.addCookies(
        keep.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite
        }))
      )
    }
    return { cleared: remove.length, kept: keep.length, keptNames: [...new Set(keep.map((c) => c.name))] }
  })
  upsertSessionMeta(profileId, { cookieCount: outcome.kept, sizeBytes: userDataSize(profileId) })
  if (outcome.kept) log('session', `清理 ${profile.name}：保留 ${outcome.kept} 条关键 cookie（${outcome.keptNames.join(', ')}）`)
  return { cleared: outcome.cleared, policy: profile.sessionPolicy ?? 'keep', kept: outcome.kept, keptKeys: outcome.keptNames }
}

/**
 * 关闭环境时按策略处理登录态，分两个阶段：
 *   before-stop：清 cookie 走 CDP，必须在内核关闭之前做；
 *   after-stop：删隔离目录必须等进程退出，否则内核会把内存里的数据再写回磁盘。
 */
export async function applyClosePolicy(profileId: string, phase: 'before-stop' | 'after-stop'): Promise<void> {
  const profile = getProfile(profileId)
  if (!profile) return
  const policy: SessionPolicy = profile.sessionPolicy ?? 'keep'
  if (policy === 'keep') return
  if (policy === 'clear_cookies' && phase === 'before-stop') {
    try {
      const res = await clearCookies(profileId)
      log('session', `按策略清理登录态：${profile.name}（${res.cleared} 条 cookie）`)
    } catch (e) {
      logError('session', `关闭时清理 cookie 失败 ${profileId}`, e)
    }
  } else if (policy === 'clear_all' && phase === 'after-stop') {
    const res = cleanupUserData(profileUserDataDir(profileId), 'session')
    upsertSessionMeta(profileId, { cookieCount: 0, sizeBytes: 0 })
    log('session', `按策略清空隔离目录：${profile.name}（释放 ${res.freedBytes} 字节）`)
  }
}

export function setPolicy(profileId: string, policy: SessionPolicy): SessionStats {
  if (!['keep', 'clear_cookies', 'clear_all'].includes(policy)) throw new Error(`未知的登录态策略：${policy}`)
  setSessionPolicy(profileId, policy)
  return stats(profileId)
}

/** 更新账号维度的登录态保留策略（永不清理 / 保留 N 天 / 关键键保护） */
export function updateRetention(profileId: string, retention: Partial<SessionRetention>): SessionStats {
  requireProfile(profileId)
  const normalized = normalizeRetention(retention)
  setRetention(profileId, normalized)
  return stats(profileId)
}

/** 需要关注的登录态：已到期或即将到期（maxAgeDays 为 null 的永不出现在这里） */
export function retentionAlerts(withinDays = 7): RetentionAlert[] {
  const at = Date.now()
  const out: RetentionAlert[] = []
  for (const p of listProfiles({ limit: 500 }).items) {
    const r = p.retention ?? DEFAULT_RETENTION
    if (r.maxAgeDays === null) continue
    const d = decideRetention(r, p.lastOpenedAt, p.createdAt, at)
    if (!d.expired && (d.daysLeft ?? 0) > withinDays) continue
    out.push({
      profileId: p.id,
      name: p.name,
      ageDays: d.ageDays,
      maxAgeDays: r.maxAgeDays,
      daysLeft: d.daysLeft,
      onExpire: r.onExpire,
      expired: d.expired,
      soon: !d.expired
    })
  }
  return out
}

/**
 * 打开环境时执行到期动作。
 *
 * 为什么放在打开时而不是关闭时：到期动作的意义是「这次要用一个干净的登录态」，
 * 等关闭再清就晚了 —— 而且如果这次打开本身就要过 Google 的新设备验证，
 * 清理时机错了反而更可疑。默认 onExpire='keep' 时这里什么都不做，只由 UI 提醒。
 */
export async function applyRetentionOnOpen(profileId: string): Promise<RetentionAlert | null> {
  const profile = getProfile(profileId)
  if (!profile) return null
  const r = profile.retention ?? DEFAULT_RETENTION
  if (r.maxAgeDays === null) return null
  const d = decideRetention(r, profile.lastOpenedAt, profile.createdAt)
  if (!d.expired) return null
  const alert: RetentionAlert = {
    profileId,
    name: profile.name,
    ageDays: d.ageDays,
    maxAgeDays: r.maxAgeDays,
    daysLeft: d.daysLeft,
    onExpire: r.onExpire,
    expired: true,
    soon: false
  }
  if (d.action === 'keep') {
    log('session', `${profile.name} 登录态已使用 ${d.ageDays} 天（策略仅提醒，不清理）`)
    return alert
  }
  if (d.action === 'clear_cookies') {
    // 没有关键键要保护时直接删磁盘上的 cookie 库：此时内核还没启动，
    // 走 CDP 反而要先临时拉起一个内核，白等一两秒。
    if (!r.protectedKeys.length) {
      const res = cleanupUserData(profileUserDataDir(profileId), 'cookies')
      upsertSessionMeta(profileId, { cookieCount: 0, sizeBytes: 0 })
      log('session', `${profile.name} 登录态到期，删除 cookie 库（释放 ${res.freedBytes} 字节）`)
    } else {
      const res = await clearCookies(profileId)
      log('session', `${profile.name} 登录态到期，清理 ${res.cleared} 条 cookie，保留 ${res.kept} 条关键键`)
    }
  } else {
    const res = cleanupUserData(profileUserDataDir(profileId), 'session')
    upsertSessionMeta(profileId, { cookieCount: 0, sizeBytes: 0 })
    log('session', `${profile.name} 登录态到期，清空隔离目录（释放 ${res.freedBytes} 字节）`)
  }
  return alert
}

export async function cleanup(profileId: string, target: CleanupTarget): Promise<CleanupResult> {
  const profile = requireProfile(profileId)
  const wasRunning = Boolean(getSession(profileId))
  if (wasRunning && target !== 'cache') {
    throw new Error('环境正在运行，只有「清理缓存」可以在线执行；清理登录态 / 隔离目录请先关闭环境')
  }
  const before = userDataSize(profileId)
  const { removed, freedBytes } = cleanupUserData(profileUserDataDir(profileId), target)
  upsertSessionMeta(profileId, {
    ...(target === 'cache' ? {} : { cookieCount: 0 }),
    sizeBytes: Math.max(before - freedBytes, 0)
  })
  log('session', `清理 ${profile.name} [${target}]：${removed.length} 项，释放 ${freedBytes} 字节`)
  return { target, removed, freedBytes, wasRunning }
}
