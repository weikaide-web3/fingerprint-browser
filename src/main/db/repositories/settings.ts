import { getDb, isDbReady } from '../index'
import { now } from '../../lib/id'

type SettingValue = string | number | boolean | null

function encode(value: SettingValue): { value: string | null; type: string } {
  if (value === null) return { value: null, type: 'null' }
  if (typeof value === 'number') return { value: String(value), type: 'number' }
  if (typeof value === 'boolean') return { value: value ? '1' : '0', type: 'boolean' }
  return { value, type: 'string' }
}

function decode(value: string | null, type: string): SettingValue {
  if (value === null || type === 'null') return null
  if (type === 'number') return Number(value)
  if (type === 'boolean') return value === '1'
  return value
}

export function getSetting<T extends SettingValue = string>(key: string, fallback: T): T {
  if (!isDbReady()) return fallback
  const row = getDb().prepare('SELECT value, type FROM settings WHERE key = ?').get(key) as
    | { value: string | null; type: string }
    | undefined
  if (!row) return fallback
  return decode(row.value, row.type) as T
}

export function setSetting(key: string, value: SettingValue): void {
  const enc = encode(value)
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, type, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = excluded.type, updated_at = excluded.updated_at`
    )
    .run(key, enc.value, enc.type, now())
}

/** 删除单个设置项（用于清理随环境消失的派生数据，如漂移基线） */
export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

/**
 * 该 key 是否被显式写入过。
 * 用来区分「从未配置」（应给安全默认值）与「用户主动清空」（应尊重其选择）。
 */
export function settingExists(key: string): boolean {
  if (!isDbReady()) return false
  return getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined
}

/** 按前缀批量删除，返回删除条数 */
export function deleteSettingsByPrefix(prefix: string): number {
  return getDb().prepare('DELETE FROM settings WHERE key LIKE ?').run(prefix + '%').changes
}

export function logAudit(action: string, targetType?: string, targetId?: string, detail?: unknown): void {
  getDb()
    .prepare('INSERT INTO audit_logs (ts, actor, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)')
    .run(now(), 'local', action, targetType ?? null, targetId ?? null, detail === undefined ? null : JSON.stringify(detail))
}

export interface AuditLogRow {
  id: number
  ts: number
  actor: string
  action: string
  targetType: string | null
  targetId: string | null
  detail: string | null
}

/** 查询审计日志（操作历史），支持按 action 前缀与时间过滤 */
export function queryAudit(opts: { limit?: number; actionPrefix?: string; since?: number } = {}): AuditLogRow[] {
  const limit = opts.limit ?? 200
  const where: string[] = []
  const params: unknown[] = []
  if (opts.actionPrefix) {
    where.push('action LIKE ?')
    params.push(`${opts.actionPrefix}%`)
  }
  if (opts.since) {
    where.push('ts >= ?')
    params.push(opts.since)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  params.push(limit)
  const rows = getDb()
    .prepare(`SELECT id, ts, actor, action, target_type, target_id, detail FROM audit_logs ${clause} ORDER BY ts DESC LIMIT ?`)
    .all(...params) as {
    id: number
    ts: number
    actor: string
    action: string
    target_type: string | null
    target_id: string | null
    detail: string | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail: r.detail
  }))
}

/** 查询环境使用日志（打开/关闭等） */
export function queryUsage(opts: { limit?: number; profileId?: string } = {}): {
  id: number
  profileId: string
  ts: number
  action: string
  ip: string | null
  detail: string | null
}[] {
  const limit = opts.limit ?? 200
  const where: string[] = []
  const params: unknown[] = []
  if (opts.profileId) {
    where.push('profile_id = ?')
    params.push(opts.profileId)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  params.push(limit)
  const rows = getDb()
    .prepare(`SELECT id, profile_id, ts, action, ip, detail FROM usage_logs ${clause} ORDER BY ts DESC LIMIT ?`)
    .all(...params) as { id: number; profile_id: string; ts: number; action: string; ip: string | null; detail: string | null }[]
  return rows.map((r) => ({ id: r.id, profileId: r.profile_id, ts: r.ts, action: r.action, ip: r.ip, detail: r.detail }))
}
