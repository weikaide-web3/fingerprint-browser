import { getDb } from '../index'
import { newId, parseJson } from '../../lib/id'
import type { ExtensionRecord } from '@shared/types'

interface ExtRow {
  id: string
  name: string
  path: string
  version: string | null
  enabled: number
  permissions: string | null
  description: string | null
  created_at: number
  deleted_at: number | null
  source: string
  store_id: string | null
}

function mapRow(row: ExtRow): ExtensionRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    version: row.version,
    enabled: Boolean(row.enabled),
    // 必须用 parseJson：一行写坏的 permissions 会让 JSON.parse 抛错，
    // 连带整个扩展列表页崩掉（mapRow 在 list 的 map 里跑）。
    permissions: parseJson<string[]>(row.permissions, []),
    description: row.description,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
    source: (row.source as 'unpacked' | 'store') ?? 'unpacked',
    storeId: row.store_id ?? null
  }
}

export function listExtensions(): ExtensionRecord[] {
  const rows = getDb().prepare('SELECT * FROM extensions WHERE deleted_at IS NULL ORDER BY created_at ASC').all() as ExtRow[]
  return rows.map(mapRow)
}

export function getExtension(id: string): ExtensionRecord | null {
  const row = getDb().prepare('SELECT * FROM extensions WHERE id = ? AND deleted_at IS NULL').get(id) as ExtRow | undefined
  return row ? mapRow(row) : null
}

export function getExtensionByPath(path: string): ExtensionRecord | null {
  const row = getDb().prepare('SELECT * FROM extensions WHERE path = ? AND deleted_at IS NULL').get(path) as ExtRow | undefined
  return row ? mapRow(row) : null
}

export function getExtensionByStoreId(storeId: string): ExtensionRecord | null {
  const row = getDb().prepare('SELECT * FROM extensions WHERE store_id = ? AND deleted_at IS NULL').get(storeId) as ExtRow | undefined
  return row ? mapRow(row) : null
}

export function createExtension(input: {
  name: string
  path: string
  version?: string | null
  permissions?: string[]
  description?: string | null
  source?: 'unpacked' | 'store'
  storeId?: string | null
}): ExtensionRecord {
  const id = newId('ext')
  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO extensions (id, name, path, version, enabled, permissions, description, source, store_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      input.name,
      input.path,
      input.version ?? null,
      1,
      JSON.stringify(input.permissions ?? []),
      input.description ?? null,
      input.source ?? 'unpacked',
      input.storeId ?? null,
      now
    )
  return {
    id,
    name: input.name,
    path: input.path,
    version: input.version ?? null,
    enabled: true,
    permissions: input.permissions ?? [],
    description: input.description ?? null,
    createdAt: now,
    source: input.source ?? 'unpacked',
    storeId: input.storeId ?? null
  }
}

/** 软删除：移入回收站（保留 profile 绑定，便于恢复） */
export function deleteExtension(id: string): void {
  getDb().prepare('UPDATE extensions SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
}

/** 从回收站恢复 */
export function restoreExtension(id: string): void {
  getDb().prepare('UPDATE extensions SET deleted_at = NULL WHERE id = ?').run(id)
}

/** 彻底删除（不可恢复）：清理绑定 + 行 */
export function purgeExtension(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM profile_extensions WHERE extension_id = ?').run(id)
  db.prepare('DELETE FROM extensions WHERE id = ?').run(id)
}

/** 回收站列表 */
export function listTrashExtensions(): ExtensionRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM extensions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all() as ExtRow[]
  return rows.map(mapRow)
}

/** 清空回收站 */
export function emptyTrashExtensions(): number {
  const db = getDb()
  db
    .prepare('DELETE FROM profile_extensions WHERE extension_id IN (SELECT id FROM extensions WHERE deleted_at IS NOT NULL)')
    .run()
  return db.prepare('DELETE FROM extensions WHERE deleted_at IS NOT NULL').run().changes
}

export function setExtensionEnabled(id: string, enabled: boolean): void {
  getDb().prepare('UPDATE extensions SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

// --- profile bindings ---

export function bindExtensionToProfile(extensionId: string, profileId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO profile_extensions (profile_id, extension_id) VALUES (?, ?)')
    .run(profileId, extensionId)
}

export function unbindExtensionFromProfile(extensionId: string, profileId: string): void {
  getDb()
    .prepare('DELETE FROM profile_extensions WHERE profile_id = ? AND extension_id = ?')
    .run(profileId, extensionId)
}

export function getExtensionsForProfile(profileId: string): ExtensionRecord[] {
  const rows = getDb()
    .prepare(
      'SELECT e.* FROM extensions e JOIN profile_extensions pe ON e.id = pe.extension_id WHERE pe.profile_id = ? AND e.enabled = 1 AND e.deleted_at IS NULL'
    )
    .all(profileId) as ExtRow[]
  return rows.map(mapRow)
}

export function getProfilesForExtension(extensionId: string): { id: string; name: string }[] {
  const rows = getDb()
    .prepare('SELECT p.id, p.name FROM profiles p JOIN profile_extensions pe ON p.id = pe.profile_id WHERE pe.extension_id = ? AND p.deleted_at IS NULL')
    .all(extensionId) as { id: string; name: string }[]
  return rows
}

export function extensionUsageCounts(): Record<string, number> {
  const rows = getDb()
    .prepare(
      'SELECT pe.extension_id AS extension_id, COUNT(*) AS cnt FROM profile_extensions pe JOIN profiles p ON p.id = pe.profile_id WHERE p.deleted_at IS NULL GROUP BY pe.extension_id'
    )
    .all() as { extension_id: string; cnt: number }[]
  const map: Record<string, number> = {}
  for (const r of rows) map[r.extension_id] = r.cnt
  return map
}