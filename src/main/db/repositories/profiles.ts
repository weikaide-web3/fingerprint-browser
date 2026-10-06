import { getDb } from '../index'
import { newId, now, parseJson } from '../../lib/id'
import { assertSafeId, profileUserDataDir } from '../../paths'
import type { FingerprintConfig, Profile, ProfileFilter, ProfileInput, ProxyRecord, ListResult } from '@shared/types'
import type { SessionPolicy, ExpireAction, SessionRetention } from '@shared/session'
import { normalizeRetention } from '../../session/retention'

interface ProfileRow {
  id: string
  name: string
  group_id: string | null
  color: string | null
  icon: string | null
  note: string | null
  kernel: string
  fingerprint_mode: string
  proxy_mode: string
  proxy_id: string | null
  user_data_dir: string
  startup_urls: string
  launch_args: string
  session_policy: string
  session_max_age_days: number | null
  session_on_expire: string
  session_protected_keys: string
  archived: number
  open_count: number
  last_opened_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

interface ProxyRow {
  id: string
  name: string
  scheme: string
  host: string
  port: number
  username: string | null
  password_enc: string | null
  group_id: string | null
  ip: string | null
  country: string | null
  region: string | null
  city: string | null
  isp: string | null
  timezone: string | null
  asn: string | null
  as_name: string | null
  org: string | null
  reverse: string | null
  usage_type: string | null
  hosting: number | null
  is_proxy: number | null
  mobile: number | null
  anycast: number | null
  quality: string | null
  quality_score: number | null
  quality_issues: string | null
  latency_ms: number | null
  last_checked_at: number | null
  checked_ok: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export function mapProxyRow(row: ProxyRow): ProxyRecord {
  return {
    id: row.id,
    name: row.name,
    scheme: row.scheme as ProxyRecord['scheme'],
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: Boolean(row.password_enc),
    groupId: row.group_id,
    ip: row.ip,
    country: row.country,
    region: row.region,
    city: row.city,
    isp: row.isp,
    timezone: row.timezone,
    asn: row.asn ?? null,
    asName: row.as_name ?? null,
    org: row.org ?? null,
    reverse: row.reverse ?? null,
    usageType: row.usage_type ?? null,
    hosting: row.hosting === 1,
    proxyExit: row.is_proxy === 1,
    mobile: row.mobile === 1,
    anycast: row.anycast === 1,
    quality: (row.quality as ProxyRecord['quality']) ?? null,
    qualityScore: row.quality_score ?? null,
    qualityIssues: parseJson<string[]>(row.quality_issues, []),
    latencyMs: row.latency_ms,
    lastCheckedAt: row.last_checked_at,
    checkedOk: row.checked_ok,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null
  }
}

function mapProfileRow(
  row: ProfileRow,
  fingerprint: FingerprintConfig | null,
  proxy: ProxyRecord | null,
  tags: string[]
): Profile {
  return {
    id: row.id,
    name: row.name,
    groupId: row.group_id,
    color: row.color,
    icon: row.icon,
    note: row.note,
    kernel: row.kernel as Profile['kernel'],
    fingerprintMode: row.fingerprint_mode as Profile['fingerprintMode'],
    proxyMode: row.proxy_mode as Profile['proxyMode'],
    proxyId: row.proxy_id,
    userDataDir: row.user_data_dir,
    startupUrls: parseJson<string[]>(row.startup_urls, []),
    launchArgs: parseJson<string[]>(row.launch_args, []),
    sessionPolicy: (row.session_policy ?? 'keep') as SessionPolicy,
    retention: normalizeRetention({
      maxAgeDays: row.session_max_age_days ?? null,
      onExpire: (row.session_on_expire ?? 'keep') as ExpireAction,
      protectedKeys: parseJson<string[]>(row.session_protected_keys, [])
    }),
    archived: row.archived,
    status: 'stopped',
    openCount: row.open_count,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    tags,
    fingerprint,
    proxy
  }
}

function loadFingerprints(ids: string[]): Map<string, FingerprintConfig> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT profile_id, config FROM fingerprints WHERE profile_id IN (${placeholders})`)
    .all(...ids) as { profile_id: string; config: string }[]
  const map = new Map<string, FingerprintConfig>()
  for (const r of rows) map.set(r.profile_id, parseJson<FingerprintConfig>(r.config, null as never))
  return map
}

function loadProxies(ids: string[]): Map<string, ProxyRecord> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const placeholders = unique.map(() => '?').join(',')
  const rows = getDb().prepare(`SELECT * FROM proxies WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...unique) as ProxyRow[]
  const map = new Map<string, ProxyRecord>()
  for (const r of rows) map.set(r.id, mapProxyRow(r))
  return map
}

function loadTags(ids: string[]): Map<string, string[]> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT profile_id, tag FROM profile_tags WHERE profile_id IN (${placeholders})`)
    .all(...ids) as { profile_id: string; tag: string }[]
  const map = new Map<string, string[]>()
  for (const r of rows) {
    const arr = map.get(r.profile_id) ?? []
    arr.push(r.tag)
    map.set(r.profile_id, arr)
  }
  return map
}

const SORT_COLS: Record<string, string> = {
  created_at: 'p.created_at',
  name: 'p.name',
  last_opened_at: 'p.last_opened_at',
  open_count: 'p.open_count'
}

export function listProfiles(filter: ProfileFilter = {}): ListResult<Profile> {
  const where: string[] = ['p.deleted_at IS NULL']
  const params: unknown[] = []
  if (!filter.includeArchived) where.push('p.archived = 0')
  if (filter.groupId !== undefined) {
    if (filter.groupId === null) where.push('p.group_id IS NULL')
    else {
      where.push('p.group_id = ?')
      params.push(filter.groupId)
    }
  }
  if (filter.search) {
    where.push('(p.name LIKE ? OR p.note LIKE ?)')
    params.push(`%${filter.search}%`, `%${filter.search}%`)
  }
  if (filter.tags?.length) {
    where.push(`p.id IN (SELECT profile_id FROM profile_tags WHERE tag IN (${filter.tags.map(() => '?').join(',')}))`)
    params.push(...filter.tags)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  // 必须兜底：未知 sort 值会让 sortCol 变成 undefined，
  // 拼出 "ORDER BY undefined DESC" 直接 SQL 语法错误，整个列表页 500。
  const sortCol = SORT_COLS[filter.sort ?? 'created_at'] ?? SORT_COLS.created_at
  const order = filter.order === 'asc' ? 'ASC' : 'DESC'
  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS c FROM profiles p ${whereSql}`)
      .get(...params) as { c: number }
  ).c
  const rows = getDb()
    .prepare(`SELECT p.* FROM profiles p ${whereSql} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`)
    .all(...params, filter.limit ?? 500, filter.offset ?? 0) as ProfileRow[]
  const ids = rows.map((r) => r.id)
  const fps = loadFingerprints(ids)
  const proxies = loadProxies(rows.map((r) => r.proxy_id ?? ''))
  const tags = loadTags(ids)
  return {
    items: rows.map((r) =>
      mapProfileRow(
        r,
        fps.get(r.id) ?? null,
        r.proxy_id ? (proxies.get(r.proxy_id) ?? null) : null,
        tags.get(r.id) ?? []
      )
    ),
    total
  }
}

export function getProfile(id: string): Profile | null {
  const row = getDb().prepare('SELECT * FROM profiles WHERE id = ? AND deleted_at IS NULL').get(id) as ProfileRow | undefined
  if (!row) return null
  const fp = getDb().prepare('SELECT config FROM fingerprints WHERE profile_id = ?').get(id) as
    | { config: string }
    | undefined
  const proxyRow = row.proxy_id
    ? (getDb().prepare('SELECT * FROM proxies WHERE id = ? AND deleted_at IS NULL').get(row.proxy_id) as ProxyRow | undefined)
    : undefined
  const tags = (getDb().prepare('SELECT tag FROM profile_tags WHERE profile_id = ?').all(id) as { tag: string }[]).map(
    (t) => t.tag
  )
  return mapProfileRow(
    row,
    fp ? parseJson<FingerprintConfig>(fp.config, null as never) : null,
    proxyRow ? mapProxyRow(proxyRow) : null,
    tags
  )
}

export function getFingerprint(profileId: string): FingerprintConfig | null {
  const row = getDb().prepare('SELECT config FROM fingerprints WHERE profile_id = ?').get(profileId) as
    | { config: string }
    | undefined
  return row ? parseJson<FingerprintConfig>(row.config, null as never) : null
}

export function saveFingerprint(profileId: string, config: FingerprintConfig): void {
  getDb()
    .prepare(
      `INSERT INTO fingerprints (id, profile_id, config, seed, generated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET config = excluded.config, seed = excluded.seed, generated_at = excluded.generated_at`
    )
    .run(newId('fp'), profileId, JSON.stringify(config), config.seed, now())
}

/**
 * 打标签必须同时写 tags 表。
 *
 * 之前只写 profile_tags，tags 表只有「新建标签」时才写入，
 * 于是 TAG_LIST 返回的清单与界面实际在用的标签脱节：
 * 用户给环境打了三个标签，标签管理页却一个都看不见，
 * 也就无法给标签配色 / 删除。这里保证两边同步。
 */
function setTags(profileId: string, tags: string[]): void {
  const db = getDb()
  db.prepare('DELETE FROM profile_tags WHERE profile_id = ?').run(profileId)
  const insert = db.prepare('INSERT OR IGNORE INTO profile_tags (profile_id, tag) VALUES (?, ?)')
  const ensureTag = db.prepare('INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES (?, ?, NULL, ?)')
  for (const t of tags) {
    insert.run(profileId, t)
    ensureTag.run(newId('tg'), t, now())
  }
}

export function createProfile(input: ProfileInput): Profile {
  const db = getDb()
  // 调用方可以指定 id（克隆 / 导入 / API 迁移），但 id 会被拼进 user-data-dir，
  // 而清理与崩溃恢复会对该目录递归删除 —— 必须先校验，防路径穿越。
  const id = input.id === undefined || input.id === null ? newId('pf') : assertSafeId(input.id)
  const ts = now()
  let fingerprint = input.fingerprint ?? null
  if (!fingerprint && input.cloneFrom) fingerprint = getFingerprint(input.cloneFrom)
  const retention = normalizeRetention(input.retention)

  db.transaction(() => {
    db.prepare(
      `INSERT INTO profiles (id, name, group_id, color, icon, note, kernel, fingerprint_mode, proxy_mode, proxy_id,
          user_data_dir, startup_urls, launch_args, session_policy, session_max_age_days, session_on_expire,
          session_protected_keys, archived, open_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`
    ).run(
      id,
      input.name,
      input.groupId ?? null,
      input.color ?? null,
      input.icon ?? null,
      input.note ?? null,
      input.kernel ?? 'chromium',
      input.fingerprintMode ?? 'auto',
      input.proxyMode ?? 'bind',
      input.proxyId ?? null,
      profileUserDataDir(id),
      JSON.stringify(input.startupUrls ?? []),
      JSON.stringify(input.launchArgs ?? []),
      input.sessionPolicy ?? 'keep',
      retention.maxAgeDays,
      retention.onExpire,
      JSON.stringify(retention.protectedKeys),
      ts,
      ts
    )
    if (fingerprint) saveFingerprint(id, fingerprint)
    if (input.tags?.length) setTags(id, input.tags)
  })()

  return getProfile(id) as Profile
}

export function updateProfile(id: string, patch: Partial<ProfileInput>): Profile | null {
  const db = getDb()
  if (!db.prepare('SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL').get(id)) return null
  const candidates: Record<string, unknown> = {
    name: patch.name,
    group_id: patch.groupId,
    color: patch.color,
    icon: patch.icon,
    note: patch.note,
    kernel: patch.kernel,
    fingerprint_mode: patch.fingerprintMode,
    proxy_mode: patch.proxyMode,
    proxy_id: patch.proxyId,
    startup_urls: patch.startupUrls ? JSON.stringify(patch.startupUrls) : undefined,
    launch_args: patch.launchArgs ? JSON.stringify(patch.launchArgs) : undefined,
    session_policy: patch.sessionPolicy,
    ...(patch.retention
      ? {
          session_max_age_days: normalizeRetention(patch.retention).maxAgeDays,
          session_on_expire: normalizeRetention(patch.retention).onExpire,
          session_protected_keys: JSON.stringify(normalizeRetention(patch.retention).protectedKeys)
        }
      : {})
  }
  const fields: string[] = []
  const values: unknown[] = []
  for (const [col, val] of Object.entries(candidates)) {
    if (val === undefined) continue
    fields.push(`${col} = ?`)
    values.push(val)
  }
  db.transaction(() => {
    if (fields.length) {
      values.push(now(), id)
      db.prepare(`UPDATE profiles SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...values)
    }
    if (patch.tags) setTags(id, patch.tags)
    if (patch.fingerprint) saveFingerprint(id, patch.fingerprint)
  })()
  return getProfile(id)
}

export function setArchived(id: string, archived: boolean): void {
  getDb().prepare('UPDATE profiles SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, now(), id)
}

export function setSessionPolicy(id: string, policy: string): void {
  getDb().prepare('UPDATE profiles SET session_policy = ?, updated_at = ? WHERE id = ?').run(policy, now(), id)
}

/** 单独更新保留策略：允许把 maxAgeDays 显式设回 null（永不清理） */
export function setRetention(id: string, retention: SessionRetention): void {
  const r = normalizeRetention(retention)
  getDb()
    .prepare(
      `UPDATE profiles SET session_max_age_days = ?, session_on_expire = ?, session_protected_keys = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(r.maxAgeDays, r.onExpire, JSON.stringify(r.protectedKeys), now(), id)
}

/** 软删除：移入回收站（保留指纹 / 标签 / 代理绑定，便于恢复） */
export function deleteProfile(id: string): void {
  getDb().prepare('UPDATE profiles SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/** 从回收站恢复 */
export function restoreProfile(id: string): void {
  const db = getDb()
  const row = db.prepare('SELECT proxy_id FROM profiles WHERE id = ?').get(id) as
    | { proxy_id: string | null }
    | undefined
  db.prepare('UPDATE profiles SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  // 连带恢复该环境绑定的、仍在回收站里的代理，避免恢复后绑定悬空
  if (row?.proxy_id) {
    db
      .prepare('UPDATE proxies SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(now(), row.proxy_id)
  }
}

/** 彻底删除（不可恢复）：真正 DELETE，级联清理指纹 / 标签 / 绑定 */
export function purgeProfile(id: string): void {
  getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id)
}

/** 回收站列表 */
export function listTrashProfiles(): Profile[] {
  const rows = getDb()
    .prepare('SELECT * FROM profiles WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all() as ProfileRow[]
  const ids = rows.map((r) => r.id)
  const fps = loadFingerprints(ids)
  const proxies = loadProxies(rows.map((r) => r.proxy_id ?? ''))
  const tags = loadTags(ids)
  return rows.map((r) =>
    mapProfileRow(r, fps.get(r.id) ?? null, r.proxy_id ? (proxies.get(r.proxy_id) ?? null) : null, tags.get(r.id) ?? [])
  )
}

/** 清空回收站：彻底删除所有软删除的环境，返回删除数量 */
export function emptyTrashProfiles(): number {
  const info = getDb().prepare('DELETE FROM profiles WHERE deleted_at IS NOT NULL').run()
  return info.changes
}

export function duplicateProfile(id: string, name: string): Profile | null {
  const src = getProfile(id)
  if (!src) return null
  return createProfile({
    name,
    groupId: src.groupId,
    color: src.color,
    icon: src.icon,
    note: src.note,
    kernel: src.kernel,
    fingerprintMode: src.fingerprintMode,
    proxyMode: src.proxyMode,
    proxyId: src.proxyId,
    startupUrls: src.startupUrls,
    launchArgs: src.launchArgs,
    sessionPolicy: src.sessionPolicy,
    tags: src.tags,
    fingerprint: src.fingerprint
  })
}

export function touchOpened(profileId: string): void {
  getDb().prepare('UPDATE profiles SET open_count = open_count + 1, last_opened_at = ? WHERE id = ?').run(
    now(),
    profileId
  )
}

export function logUsage(profileId: string, action: string, detail?: unknown): void {
  getDb()
    .prepare('INSERT INTO usage_logs (profile_id, ts, action, detail) VALUES (?, ?, ?, ?)')
    .run(profileId, now(), action, detail === undefined ? null : JSON.stringify(detail))
}
