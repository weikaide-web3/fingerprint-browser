import { getDb } from '../index'
import { newId, now } from '../../lib/id'
import type { Http2Fingerprint, TlsBaseline, TlsObservation } from '@shared/tls'

/**
 * tls_observations / tls_baselines 仓储。
 *
 * 观测记录按环境存，基线按内核版本存：只有两者都齐，才能回答
 * 「这个环境的 TLS 形状是不是它声称的那个 Chrome」。
 */

interface ObsRow {
  id: string
  profile_id: string
  proxy_id: string | null
  host: string
  via: string
  ja3: string
  ja3_stable: string | null
  ja3_sorted: string | null
  ext_order: string | null
  ja4: string
  ja4r: string | null
  h2fp: string | null
  version_label: string | null
  alpn: string | null
  cipher_count: number | null
  ext_count: number | null
  grease_count: number | null
  kernel_version: string | null
  observed_at: number
}

interface BaseRow {
  kernel_version: string
  chrome_major: number
  ja3: string
  ja3_stable: string | null
  ja3_sorted: string | null
  ja4: string
  ja4r: string | null
  h2fp: string | null
  cipher_count: number | null
  ext_count: number | null
  grease_count: number | null
  samples: number
  observed_at: number
}

function toH2(fp: string | null): Http2Fingerprint | null {
  if (!fp) return null
  // 存的是规范化字符串；回读时只有 fp 参与比对，其余字段留空
  return { preface: true, settings: [], priorities: [], preludeFrames: [], windowUpdate: null, fp }
}

function toObs(r: ObsRow): TlsObservation {
  return {
    id: r.id,
    profileId: r.profile_id,
    proxyId: r.proxy_id,
    host: r.host,
    observedAt: r.observed_at,
    kernelVersion: r.kernel_version ?? '',
    via: r.via === 'origin' ? 'origin' : 'tap',
    tls: {
      ja3: r.ja3,
      ja3String: '',
      ja3Stable: r.ja3_stable ?? '',
      ja3StableString: '',
      ja3Sorted: r.ja3_sorted ?? '',
      ja3SortedString: '',
      extOrder: r.ext_order ?? '',
      ja4: r.ja4,
      ja4r: r.ja4r ?? '',
      versionLabel: r.version_label ?? '',
      sni: null,
      alpn: (r.alpn ?? '').split(',').filter(Boolean),
      cipherCount: r.cipher_count ?? 0,
      extensionCount: r.ext_count ?? 0,
      greaseCount: r.grease_count ?? 0
    },
    h2: toH2(r.h2fp)
  }
}

export function insertObservation(o: Omit<TlsObservation, 'id'>): TlsObservation {
  const id = newId('tlsobs')
  getDb()
    .prepare(
      `INSERT INTO tls_observations
       (id, profile_id, proxy_id, host, via, ja3, ja3_stable, ja3_sorted, ext_order, ja4, ja4r, h2fp, version_label, alpn,
        cipher_count, ext_count, grease_count, kernel_version, observed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      o.profileId,
      o.proxyId ?? null,
      o.host,
      o.via,
      o.tls.ja3,
      o.tls.ja3Stable || null,
      o.tls.ja3Sorted || null,
      o.tls.extOrder || null,
      o.tls.ja4,
      o.tls.ja4r,
      o.h2?.fp ?? null,
      o.tls.versionLabel,
      o.tls.alpn.join(','),
      o.tls.cipherCount,
      o.tls.extensionCount,
      o.tls.greaseCount,
      o.kernelVersion,
      o.observedAt || now()
    )
  return { ...o, id }
}

export function listObservations(profileId: string, limit = 20): TlsObservation[] {
  const rows = getDb()
    .prepare('SELECT * FROM tls_observations WHERE profile_id = ? ORDER BY observed_at DESC LIMIT ?')
    .all(profileId, limit) as ObsRow[]
  return rows.map(toObs)
}

export function latestObservation(profileId: string): TlsObservation | null {
  return listObservations(profileId, 1)[0] ?? null
}

export function pruneObservations(keep = 500): number {
  const info = getDb()
    .prepare(`DELETE FROM tls_observations WHERE id NOT IN (SELECT id FROM tls_observations ORDER BY observed_at DESC LIMIT ?)`)
    .run(keep)
  return info.changes
}

export function upsertBaseline(b: TlsBaseline): TlsBaseline {
  getDb()
    .prepare(
      `INSERT INTO tls_baselines
       (kernel_version, chrome_major, ja3, ja3_stable, ja3_sorted, ja4, ja4r, h2fp, cipher_count, ext_count, grease_count, samples, observed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(kernel_version) DO UPDATE SET
         chrome_major = excluded.chrome_major,
         ja3 = excluded.ja3,
         ja3_stable = excluded.ja3_stable,
         ja3_sorted = excluded.ja3_sorted,
         ja4 = excluded.ja4,
         ja4r = excluded.ja4r,
         h2fp = excluded.h2fp,
         cipher_count = excluded.cipher_count,
         ext_count = excluded.ext_count,
         grease_count = excluded.grease_count,
         samples = excluded.samples,
         observed_at = excluded.observed_at`
    )
    .run(
      b.kernelVersion,
      b.chromeMajor,
      b.ja3,
      b.ja3Stable,
      b.ja3Sorted,
      b.ja4,
      b.ja4r,
      b.h2fp,
      b.cipherCount,
      b.extensionCount,
      b.greaseCount,
      b.samples,
      b.observedAt || now()
    )
  return b
}

function toBase(row: BaseRow): TlsBaseline {
  return {
    kernelVersion: row.kernel_version,
    chromeMajor: row.chrome_major,
    ja3: row.ja3,
    ja3Stable: row.ja3_stable ?? '',
    ja3Sorted: row.ja3_sorted ?? '',
    ja4: row.ja4,
    ja4r: row.ja4r ?? '',
    h2fp: row.h2fp,
    cipherCount: row.cipher_count ?? 0,
    extensionCount: row.ext_count ?? 0,
    greaseCount: row.grease_count ?? 0,
    samples: row.samples,
    observedAt: row.observed_at
  }
}

export function getBaseline(kernelVersion: string): TlsBaseline | null {
  const row = getDb().prepare('SELECT * FROM tls_baselines WHERE kernel_version = ?').get(kernelVersion) as BaseRow | undefined
  return row ? toBase(row) : null
}

export function listBaselines(): TlsBaseline[] {
  const rows = getDb().prepare('SELECT * FROM tls_baselines ORDER BY observed_at DESC').all() as BaseRow[]
  return rows.map(toBase)
}

/**
 * 用某个内核版本的历史观测聚合出基线（取出现次数最多的形状）。
 *
 * 为什么取众数而不是首次值：同一内核连不同站点会因为 ALPN / SNI 产生细微差异，
 * 取众数才是「这个内核应该长什么样」的稳定答案。
 */
export function buildBaseline(kernelVersion: string, chromeMajor: number): TlsBaseline | null {
  const rows = getDb()
    .prepare("SELECT * FROM tls_observations WHERE kernel_version = ? AND ja4 <> '' ORDER BY observed_at DESC LIMIT 200")
    .all(kernelVersion) as ObsRow[]
  if (!rows.length) return null

  // 按「排序后的 JA3 + H2 形状」取众数：原始 JA3 每次连接都变（GREASE 与扩展顺序
  // 都会抖），用它当键会让每个形状都只出现一次，众数就退化成「最近一次观测」。
  const tally = new Map<string, ObsRow[]>()
  for (const r of rows) {
    const key = `${r.ja3_sorted ?? r.ja3_stable ?? r.ja4}|${r.h2fp ?? ''}`
    const list = tally.get(key) ?? []
    list.push(r)
    tally.set(key, list)
  }
  let best: ObsRow[] = []
  for (const list of tally.values()) if (list.length > best.length) best = list
  const top = best[0]
  if (!top) return null

  return upsertBaseline({
    kernelVersion,
    chromeMajor,
    ja3: top.ja3,
    ja3Stable: top.ja3_stable ?? '',
    ja3Sorted: top.ja3_sorted ?? '',
    ja4: top.ja4,
    ja4r: top.ja4r ?? '',
    h2fp: top.h2fp,
    cipherCount: top.cipher_count ?? 0,
    extensionCount: top.ext_count ?? 0,
    greaseCount: top.grease_count ?? 0,
    samples: best.length,
    observedAt: now()
  })
}

/** 有观测记录但没有基线的内核版本（UI 提示「先采集基线」用） */
export function kernelsWithoutBaseline(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT kernel_version AS k FROM tls_observations
       WHERE kernel_version IS NOT NULL AND kernel_version <> ''
         AND kernel_version NOT IN (SELECT kernel_version FROM tls_baselines)`
    )
    .all() as { k: string }[]
  return rows.map((r) => r.k)
}