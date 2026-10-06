import type Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { MIGRATIONS } from './migrations'

let db: Database.Database | null = null

/**
 * better-sqlite3 是按 Electron ABI 编译的原生模块，
 * 因此只在真正需要时加载，避免纯 Node 工具链（测试/脚本）导入即崩溃。
 */
function openDatabase(file: string): Database.Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('better-sqlite3') as unknown
  const Ctor = ((mod as { default?: unknown }).default ?? mod) as typeof Database
  return new Ctor(file)
}

function migrate(handle: Database.Database): void {
  handle.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
  )
  const applied = new Set(
    (handle.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id)
  )
  const insert = handle.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    handle.transaction(() => {
      handle.exec(m.sql)
      insert.run(m.id, m.name, Date.now())
    })()
  }
}

export function initDatabase(dbFile: string): Database.Database {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  db = openDatabase(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised')
  return db
}

/** 纯 Node 工具链（测试/脚本）下数据库可能未初始化，调用方可据此降级 */
export function isDbReady(): boolean {
  return db !== null
}

export function closeDatabase(): void {
  db?.close()
  db = null
}
