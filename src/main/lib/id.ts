import { randomUUID } from 'node:crypto'

export function newId(prefix = ''): string {
  const raw = randomUUID()
  return prefix ? `${prefix}_${raw.replace(/-/g, '').slice(0, 20)}` : raw
}

export function now(): number {
  return Date.now()
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
