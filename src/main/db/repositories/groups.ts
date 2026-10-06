import { getDb } from '../index'
import { newId, now } from '../../lib/id'
import type { Group, Tag } from '@shared/types'

export function listGroups(): Group[] {
  const rows = getDb().prepare('SELECT * FROM groups ORDER BY sort_order ASC, created_at ASC').all() as Record<
    string,
    unknown
  >[]
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    color: (r.color as string) ?? null,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as number
  }))
}

export function createGroup(name: string, color?: string | null, sortOrder = 0): Group {
  const id = newId('gp')
  getDb()
    .prepare('INSERT INTO groups (id, name, color, sort_order, created_at) VALUES (?,?,?,?,?)')
    .run(id, name, color ?? null, sortOrder, now())
  return listGroups().find((g) => g.id === id) as Group
}

export function updateGroup(id: string, patch: { name?: string; color?: string | null; sortOrder?: number }): Group | null {
  const fields: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) (fields.push('name = ?'), values.push(patch.name))
  if (patch.color !== undefined) (fields.push('color = ?'), values.push(patch.color))
  if (patch.sortOrder !== undefined) (fields.push('sort_order = ?'), values.push(patch.sortOrder))
  if (fields.length) {
    values.push(id)
    getDb().prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return listGroups().find((g) => g.id === id) ?? null
}

export function deleteGroup(id: string): void {
  getDb().prepare('DELETE FROM groups WHERE id = ?').run(id)
}

export function listTags(): Tag[] {
  const rows = getDb().prepare('SELECT * FROM tags ORDER BY name ASC').all() as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    color: (r.color as string) ?? null,
    createdAt: r.created_at as number
  }))
}

export function createTag(name: string, color?: string | null): Tag {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: string } | undefined
  if (existing) return listTags().find((t) => t.id === existing.id) as Tag
  const id = newId('tg')
  db.prepare('INSERT INTO tags (id, name, color, created_at) VALUES (?,?,?,?)').run(id, name, color ?? null, now())
  return listTags().find((t) => t.id === id) as Tag
}

export function deleteTag(name: string): void {
  const db = getDb()
  db.prepare('DELETE FROM profile_tags WHERE tag = ?').run(name)
  db.prepare('DELETE FROM tags WHERE name = ?').run(name)
}
