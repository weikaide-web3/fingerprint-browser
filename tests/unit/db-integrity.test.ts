import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import { MIGRATIONS } from '../../src/main/db/migrations'
import { setDataDir, ensureDir, dbFile } from '../../src/main/paths'
import { initDatabase, closeDatabase, getDb } from '../../src/main/db'

/**
 * 引用完整性迁移（M14）与日志保留的回归测试。
 *
 * 为什么必须直接跑 SQL 而不是走 initDatabase：要构造「已有库 + 存在孤儿行」的
 * 前置状态，才能证明迁移真的把孤儿清掉了、外键真的生效了。
 * 这类问题（环境删了但 passkey 私钥还在）在功能测试里完全看不出来。
 */

let tmpDir = ''
let db: import('better-sqlite3').Database
let fileSeq = 0

function openWithMigrations(upto: number): import('better-sqlite3').Database {
  // 每个用例一个独立文件：复用同名文件会把上一个用例的 _migrations 行带进来，
  // 于是重复插同一个 id 直接 UNIQUE 失败。
  const file = path.join(tmpDir, `app-${upto}-${fileSeq++}.db`)
  const h = new Database(file)
  h.pragma('journal_mode = WAL')
  h.pragma('foreign_keys = ON')
  h.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
  )
  const insert = h.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
  for (const m of MIGRATIONS.slice(0, upto)) {
    h.transaction(() => {
      h.exec(m.sql)
      insert.run(m.id, m.name, Date.now())
    })()
  }
  return h
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-integrity-'))
})

afterAll(() => {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('M14 引用完整性迁移', () => {
  beforeEach(() => {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    // 先建到 13（模拟老版本已有数据），再单独跑 14
    db = openWithMigrations(13)
    db.prepare('INSERT INTO profiles (id,name,user_data_dir,created_at,updated_at) VALUES (?,?,?,?,?)').run(
      'p1',
      'env',
      '/x',
      1,
      1
    )
    const wa = db.prepare(
      'INSERT INTO webauthn_credentials (id,profile_id,rp_id,public_key,credential_id,private_key,aaguid,created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    wa.run('w1', 'p1', 'google.com', 'pk', 'cid', 'sk', 'aa', 1)
    wa.run('w2', 'ghost', 'google.com', 'pk', 'cid2', 'sk', 'aa', 1)
    db.prepare('INSERT INTO tls_observations (id,profile_id,host,via,ja3,ja4,observed_at) VALUES (?,?,?,?,?,?,?)').run(
      't1',
      'p1',
      'h',
      'direct',
      'j',
      'j4',
      1
    )
    db.prepare('INSERT INTO tls_observations (id,profile_id,host,via,ja3,ja4,observed_at) VALUES (?,?,?,?,?,?,?)').run(
      't2',
      'ghost',
      'h',
      'direct',
      'j',
      'j4',
      1
    )
    db.prepare('INSERT INTO profile_tags (profile_id,tag) VALUES (?,?)').run('p1', 'tagged')
  })

  function runM14(): void {
    const m14 = MIGRATIONS.find((m) => m.id === 14)
    expect(m14, 'M14 必须存在').toBeDefined()
    db.transaction(() => {
      db.exec(m14!.sql)
    })()
  }

  const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c

  it('迁移前确实存在孤儿凭据（否则测试没有意义）', () => {
    expect(count('webauthn_credentials')).toBe(2)
    expect(count('tls_observations')).toBe(2)
  })

  it('迁移清掉孤儿 passkey 与 TLS 观测', () => {
    runM14()
    expect(count('webauthn_credentials')).toBe(1)
    expect(count('tls_observations')).toBe(1)
  })

  it('迁移后彻底删除环境会级联清掉 passkey 私钥与 TLS 观测', () => {
    runM14()
    db.prepare('DELETE FROM profiles WHERE id = ?').run('p1')
    expect(count('webauthn_credentials')).toBe(0)
    expect(count('tls_observations')).toBe(0)
  })

  it('迁移后插入孤儿凭据会被外键拒绝', () => {
    runM14()
    expect(() =>
      db
        .prepare(
          'INSERT INTO webauthn_credentials (id,profile_id,rp_id,public_key,credential_id,private_key,aaguid,created_at) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run('w9', 'nope', 'r', 'pk', 'c', 'sk', 'aa', 1)
    ).toThrow(/FOREIGN KEY/)
  })

  it('迁移保留原有列与数据（重建表最容易丢列）', () => {
    db.prepare('UPDATE tls_observations SET ja3_stable = ?, ja3_sorted = ?, ext_order = ? WHERE id = ?').run(
      'js',
      'jso',
      '[0,10]',
      't1'
    )
    runM14()
    const row = db.prepare('SELECT ja3_stable, ja3_sorted, ext_order FROM tls_observations WHERE id = ?').get('t1') as {
      ja3_stable: string
      ja3_sorted: string
      ext_order: string
    }
    expect(row.ja3_stable).toBe('js')
    expect(row.ja3_sorted).toBe('jso')
    expect(row.ext_order).toBe('[0,10]')
    const wa = db.prepare('SELECT sign_count, is_resident, aaguid FROM webauthn_credentials WHERE id = ?').get('w1') as {
      sign_count: number
      is_resident: number
      aaguid: string
    }
    expect(wa.aaguid).toBe('aa')
    expect(wa.sign_count).toBe(0)
    expect(wa.is_resident).toBe(1)
  })

  it('迁移后 UNIQUE 约束仍然生效', () => {
    runM14()
    const ins = db.prepare(
      'INSERT INTO webauthn_credentials (id,profile_id,rp_id,public_key,credential_id,private_key,aaguid,created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    // w1 已占用 (p1, google.com, cid)，先插一个不同 credential_id 的应当成功
    ins.run('w3', 'p1', 'google.com', 'pk', 'cid-other', 'sk', 'aa', 1)
    // 再插同三元组必须被 UNIQUE 拦住
    expect(() => ins.run('w4', 'p1', 'google.com', 'pk', 'cid-other', 'sk2', 'aa', 1)).toThrow(/UNIQUE/)
  })

  it('迁移后 schema 与外键自检通过', () => {
    runM14()
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('tags 表被回填成实际在用的标签清单', () => {
    expect(count('tags')).toBe(0)
    runM14()
    const names = (db.prepare('SELECT name FROM tags').all() as { name: string }[]).map((r) => r.name)
    expect(names).toContain('tagged')
  })

  it('迁移可重复执行（索引与回填都是幂等的）', () => {
    runM14()
    expect(() => runM14()).not.toThrow()
  })
})

describe('数据库日志保留', () => {
  // pruneDbLogs / dbLogCounts 走的是 db/index.ts 的单例连接，
  // 所以这部分必须用 initDatabase 建库，而不是自己 new 一个句柄。
  let retDir = ''

  beforeAll(() => {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    retDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-retention-'))
    setDataDir(retDir)
    ensureDir(path.join(retDir, 'profiles'))
    initDatabase(dbFile())
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(retDir, { recursive: true, force: true })
  })

  it('pruneDbLogs 把三张日志表裁到上限内', async () => {
    const { pruneDbLogs, DEFAULT_DB_RETENTION } = await import('../../src/main/db/repositories/retention')
    const handle = getDb()
    const audit = handle.prepare('INSERT INTO audit_logs (ts, action) VALUES (?, ?)')
    const usage = handle.prepare('INSERT INTO usage_logs (profile_id, ts, action) VALUES (?, ?, ?)')
    for (let i = 0; i < 300; i += 1) audit.run(1000 + i, `a${i}`)
    for (let i = 0; i < 300; i += 1) usage.run('p1', 1000 + i, `u${i}`)
    expect((handle.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c).toBe(300)

    const removed = pruneDbLogs({ auditLogs: 100, usageLogs: 50, rpaRuns: 0 })
    expect(removed.auditLogs).toBe(200)
    expect(removed.usageLogs).toBe(250)
    expect((handle.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c).toBe(100)
    // 保留的必须是最近的（id 最大的一批），不是随机 100 条
    const oldest = handle.prepare('SELECT MIN(id) AS m FROM audit_logs').get() as { m: number }
    expect(oldest.m).toBeGreaterThan(200)
    expect(DEFAULT_DB_RETENTION.auditLogs).toBeGreaterThan(0)
  })

  it('上限为 0 时不清理（0 表示不限制，不是清空）', async () => {
    const { pruneDbLogs } = await import('../../src/main/db/repositories/retention')
    const handle = getDb()
    const before = (handle.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c
    const removed = pruneDbLogs({ auditLogs: 0 })
    expect(removed.auditLogs).toBe(0)
    expect((handle.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c).toBe(before)
  })

  it('dbLogCounts 返回三张表的行数', async () => {
    const { dbLogCounts } = await import('../../src/main/db/repositories/retention')
    const c = dbLogCounts()
    expect(typeof c.auditLogs).toBe('number')
    expect(typeof c.usageLogs).toBe('number')
    expect(typeof c.rpaRuns).toBe('number')
  })
})
