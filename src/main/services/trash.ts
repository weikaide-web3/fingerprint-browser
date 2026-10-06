import * as profiles from './profiles'
import * as proxies from './proxies'
import * as extensions from './extensions'
import { logAudit } from '../db/repositories/settings'

/**
 * 统一回收站：把环境 / 代理 / 扩展三类实体的软删除聚合到一个入口。
 * 删除走各自 service 的 remove/uninstall（已是软删除），
 * 这里提供 list / restore / purge / empty，按 kind 分派。
 */

export type TrashKind = 'profile' | 'proxy' | 'extension'

export interface TrashItem {
  kind: TrashKind
  id: string
  name: string
  deletedAt: number | null
  meta?: string
}

function toItems(): TrashItem[] {
  const out: TrashItem[] = []
  for (const p of profiles.trash()) {
    out.push({ kind: 'profile', id: p.id, name: p.name, deletedAt: p.deletedAt ?? null, meta: p.note ?? undefined })
  }
  for (const p of proxies.trash()) {
    out.push({ kind: 'proxy', id: p.id, name: p.name, deletedAt: p.deletedAt ?? null, meta: `${p.scheme}://${p.host}:${p.port}` })
  }
  for (const e of extensions.trash()) {
    out.push({ kind: 'extension', id: e.id, name: e.name, deletedAt: e.deletedAt ?? null, meta: e.version ?? undefined })
  }
  return out.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}

export function list(): TrashItem[] {
  return toItems()
}

export function restore(kind: TrashKind, id: string): void {
  if (kind === 'profile') profiles.restore(id)
  else if (kind === 'proxy') proxies.restore(id)
  else extensions.restore(id)
  logAudit('trash.restore', kind, id)
}

export function purge(kind: TrashKind, id: string): void {
  if (kind === 'profile') profiles.purge(id)
  else if (kind === 'proxy') proxies.purge(id)
  else extensions.purge(id)
  logAudit('trash.purge', kind, id)
}

/** 清空回收站（三类全清），返回删除总数 */
export function empty(): number {
  const n = profiles.emptyTrash() + proxies.emptyTrash() + extensions.emptyTrash()
  logAudit('trash.empty', 'trash', undefined, { removed: n })
  return n
}
