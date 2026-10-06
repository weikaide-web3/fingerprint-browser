import { getDb } from '../index'
import { now } from '../../lib/id'

/**
 * sessions_meta：登录态的「账本」。
 * cookie 本体存在内核的 user-data 里，这里只记数量 / 体积 / 快照路径，
 * 让列表页不必为了显示体积就去扫盘或启动内核。
 */
export interface SessionMetaRow {
  profile_id: string
  cookie_count: number
  storage_state_path: string | null
  size_bytes: number
  updated_at: number
}

export function getSessionMeta(profileId: string): SessionMetaRow | null {
  const row = getDb().prepare('SELECT * FROM sessions_meta WHERE profile_id = ?').get(profileId)
  return (row as SessionMetaRow | undefined) ?? null
}

export function allSessionMeta(): Map<string, SessionMetaRow> {
  const rows = getDb().prepare('SELECT * FROM sessions_meta').all() as SessionMetaRow[]
  const map = new Map<string, SessionMetaRow>()
  for (const r of rows) map.set(r.profile_id, r)
  return map
}

export function upsertSessionMeta(
  profileId: string,
  patch: { cookieCount?: number; storageStatePath?: string | null; sizeBytes?: number }
): SessionMetaRow {
  const prev = getSessionMeta(profileId)
  const cookieCount = patch.cookieCount ?? prev?.cookie_count ?? 0
  const storageStatePath =
    patch.storageStatePath === undefined ? (prev?.storage_state_path ?? null) : patch.storageStatePath
  const sizeBytes = patch.sizeBytes ?? prev?.size_bytes ?? 0
  getDb()
    .prepare(
      `INSERT INTO sessions_meta (profile_id, cookie_count, storage_state_path, size_bytes, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(profile_id) DO UPDATE SET
         cookie_count = excluded.cookie_count,
         storage_state_path = excluded.storage_state_path,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`
    )
    .run(profileId, cookieCount, storageStatePath, sizeBytes, now())
  return { profile_id: profileId, cookie_count: cookieCount, storage_state_path: storageStatePath, size_bytes: sizeBytes, updated_at: now() }
}

export function dropSessionMeta(profileId: string): void {
  getDb().prepare('DELETE FROM sessions_meta WHERE profile_id = ?').run(profileId)
}
