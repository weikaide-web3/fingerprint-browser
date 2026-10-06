import { getDb } from '../index'
import { newId, now } from '../../lib/id'
import { encryptSecret } from '../../lib/crypto'
import { mapProxyRow } from './profiles'
import type { ProxyInput, ProxyRecord } from '@shared/types'

export function listProxies(): ProxyRecord[] {
  const rows = getDb().prepare('SELECT * FROM proxies WHERE deleted_at IS NULL ORDER BY created_at DESC').all() as Parameters<
    typeof mapProxyRow
  >[0][]
  return rows.map(mapProxyRow)
}

export function getProxy(id: string): ProxyRecord | null {
  const row = getDb().prepare('SELECT * FROM proxies WHERE id = ? AND deleted_at IS NULL').get(id) as
    | Parameters<typeof mapProxyRow>[0]
    | undefined
  return row ? mapProxyRow(row) : null
}

export function getProxyPassword(id: string): string | null {
  const row = getDb().prepare('SELECT password_enc FROM proxies WHERE id = ? AND deleted_at IS NULL').get(id) as
    | { password_enc: string | null }
    | undefined
  return row?.password_enc ?? null
}

export function createProxy(input: ProxyInput & { password?: string | null }): ProxyRecord {
  const id = newId('px')
  getDb()
    .prepare(
      `INSERT INTO proxies (id, name, scheme, host, port, username, password_enc, group_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.name ?? '',
      input.scheme,
      input.host,
      input.port,
      input.username ?? null,
      encryptSecret(input.password),
      input.groupId ?? null,
      now(),
      now()
    )
  return getProxy(id) as ProxyRecord
}

export function updateProxy(
  id: string,
  patch: Partial<ProxyInput> & { password?: string | null; name?: string }
): ProxyRecord | null {
  const fields: string[] = []
  const values: unknown[] = []
  const push = (col: string, val: unknown): void => {
    fields.push(`${col} = ?`)
    values.push(val)
  }
  if (patch.name !== undefined) push('name', patch.name)
  if (patch.scheme !== undefined) push('scheme', patch.scheme)
  if (patch.host !== undefined) push('host', patch.host)
  if (patch.port !== undefined) push('port', patch.port)
  if (patch.username !== undefined) push('username', patch.username)
  if (patch.groupId !== undefined) push('group_id', patch.groupId)
  if (patch.password !== undefined) push('password_enc', encryptSecret(patch.password))
  if (fields.length) {
    push('updated_at', now())
    values.push(id)
    getDb().prepare(`UPDATE proxies SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return getProxy(id)
}

/** 软删除：移入回收站（保留环境绑定，便于恢复） */
export function deleteProxy(id: string): void {
  getDb().prepare('UPDATE proxies SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
}

/** 从回收站恢复 */
export function restoreProxy(id: string): void {
  getDb().prepare('UPDATE proxies SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
}

/** 彻底删除（不可恢复） */
export function purgeProxy(id: string): void {
  getDb().prepare('DELETE FROM proxies WHERE id = ?').run(id)
}

/** 回收站列表 */
export function listTrashProxies(): ProxyRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM proxies WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all() as Parameters<typeof mapProxyRow>[0][]
  return rows.map(mapProxyRow)
}

/** 清空回收站 */
export function emptyTrashProxies(): number {
  return getDb().prepare('DELETE FROM proxies WHERE deleted_at IS NOT NULL').run().changes
}

export interface ProxyCheckResult {
  ip: string | null
  country: string | null
  region: string | null
  city: string | null
  isp: string | null
  timezone: string | null
  asn: string | null
  asName: string | null
  org: string | null
  reverse: string | null
  usageType: string | null
  hosting: boolean
  isProxy: boolean
  mobile: boolean
  anycast: boolean
  quality: string | null
  qualityScore: number | null
  qualityIssues: string[]
  latencyMs: number | null
  ok: boolean
}

export function saveProxyCheck(id: string, r: ProxyCheckResult): void {
  getDb()
    .prepare(
      `UPDATE proxies SET ip=?, country=?, region=?, city=?, isp=?, timezone=?,
         asn=?, as_name=?, org=?, reverse=?, usage_type=?, hosting=?, is_proxy=?, mobile=?, anycast=?,
         quality=?, quality_score=?, quality_issues=?,
         latency_ms=?, last_checked_at=?, checked_ok=?, updated_at=?
       WHERE id = ?`
    )
    .run(
      r.ip,
      r.country,
      r.region,
      r.city,
      r.isp,
      r.timezone,
      r.asn,
      r.asName,
      r.org,
      r.reverse,
      r.usageType,
      r.hosting ? 1 : 0,
      r.isProxy ? 1 : 0,
      r.mobile ? 1 : 0,
      r.anycast ? 1 : 0,
      r.quality,
      r.qualityScore,
      JSON.stringify(r.qualityIssues ?? []),
      r.latencyMs,
      now(),
      r.ok ? 1 : 0,
      now(),
      id
    )
}
