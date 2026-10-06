import {
  listProxies,
  getProxy,
  createProxy,
  updateProxy,
  deleteProxy,
  getProxyPassword,
  saveProxyCheck,
  restoreProxy,
  purgeProxy,
  listTrashProxies,
  emptyTrashProxies,
  type ProxyCheckResult
} from '../db/repositories/proxies'
import { getDb } from '../db'
import { getSession } from '../browser/registry'
import { typedSetting } from '../settings/defs'
import { getSetting } from '../db/repositories/settings'
import { decryptSecret } from '../lib/crypto'
import {
  probeProxy,
  parseExitInfo,
  judgeIpQuality,
  DEFAULT_TARGET,
  type ProbeTarget,
  type ProxyEndpoint,
  type IpQualityVerdict
} from '../proxy/checker'
import { validateProxyInput, parseProxyLine, type ValidatedProxyInput } from '../proxy/parse'
import { log } from '../lib/log'
import type { ProxyInput, ProxyRecord } from '@shared/types'

export type { ValidatedProxyInput }

export function list(): ProxyRecord[] {
  return listProxies()
}

/** 每个代理被多少个环境绑定，供列表展示与删除前提示 */
export function usageCounts(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT proxy_id AS proxyId, COUNT(*) AS n FROM profiles WHERE proxy_id IS NOT NULL AND deleted_at IS NULL GROUP BY proxy_id')
    .all() as { proxyId: string; n: number }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[r.proxyId] = r.n
  return out
}

export function boundProfiles(proxyId: string): { id: string; name: string; status: string }[] {
  const rows = getDb()
    .prepare('SELECT id, name FROM profiles WHERE proxy_id = ? AND deleted_at IS NULL ORDER BY name')
    .all(proxyId) as { id: string; name: string }[]
  return rows.map((r) => ({ ...r, status: 'stopped' }))
}

export function create(input: ProxyInput & { password?: string | null }): ProxyRecord {
  const v = validateProxyInput(input)
  const dup = listProxies().find((p) => p.scheme === v.scheme && p.host === v.host && p.port === v.port)
  if (dup) throw new Error(`该代理已存在（${dup.name}）`)
  const created = createProxy({ ...v, password: v.password ?? null })
  log('proxy', `新增代理 ${created.name} (${created.id})`)
  return created
}

export function update(id: string, patch: Partial<ProxyInput> & { password?: string | null }): ProxyRecord | null {
  if (!getProxy(id)) return null
  // 只填了部分字段时，用库里现值补全后再整体校验，避免半套配置写进库
  const current = getProxy(id) as ProxyRecord
  const merged: Partial<ProxyInput> & { password?: string | null } = {
    name: patch.name ?? current.name,
    scheme: patch.scheme ?? current.scheme,
    host: patch.host ?? current.host,
    port: patch.port ?? current.port,
    username: patch.username === undefined ? current.username : patch.username,
    groupId: patch.groupId === undefined ? current.groupId : patch.groupId
  }
  if (patch.password !== undefined) merged.password = patch.password
  const v = validateProxyInput(merged)
  const updated = updateProxy(id, v)
  if (updated) log('proxy', `更新代理 ${updated.name} (${id})`)
  return updated
}

/**
 * 检测目标可通过设置项覆盖，便于离线环境指向自建服务。
 * 导出给自动化 API 的 /ip/check 复用，避免两处对 proxy.checkUrl 的解析规则漂移。
 */
export function checkTarget(): ProbeTarget {
  const url = String(getSetting('proxy.checkUrl', '') ?? '')
  if (!url) return DEFAULT_TARGET
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('proxy.checkUrl 只支持 http / https')
    const secure = u.protocol === 'https:'
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : secure ? 443 : 80,
      path: `${u.pathname}${u.search}`,
      tls: secure
    }
  } catch (e) {
    log('proxy', `proxy.checkUrl 配置无效，改用默认出口服务：${e instanceof Error ? e.message : e}`)
    return DEFAULT_TARGET
  }
}

function checkTimeout(): number {
  return typedSetting<number>('proxy.checkTimeoutMs', 10000)
}

const BLANK_CHECK: ProxyCheckResult = {
  ip: null,
  country: null,
  region: null,
  city: null,
  isp: null,
  timezone: null,
  asn: null,
  asName: null,
  org: null,
  reverse: null,
  usageType: null,
  hosting: false,
  isProxy: false,
  mobile: false,
  anycast: false,
  quality: 'unknown',
  qualityScore: 0,
  qualityIssues: ['未能取得出口信息'],
  latencyMs: null,
  ok: false
}

export interface CheckOutcome {
  ok: boolean
  error: string | null
  proxy: ProxyRecord | null
  /** 出口质量判定；检测失败时为 unknown */
  quality: IpQualityVerdict
}

export async function check(id: string): Promise<CheckOutcome> {
  const p = getProxy(id)
  if (!p) throw new Error(`代理不存在：${id}`)
  const ep: ProxyEndpoint = {
    scheme: p.scheme,
    host: p.host,
    port: p.port,
    username: p.username,
    password: decryptSecret(getProxyPassword(id))
  }
  const out = await probeProxy(ep, checkTarget(), checkTimeout())
  // 延迟记的是到代理的 TCP 建连耗时，这才是用户理解的「代理延迟」
  const latency = out.connectMs > 0 ? out.connectMs : out.totalMs
  if (!out.ok) {
    saveProxyCheck(id, { ...BLANK_CHECK, latencyMs: latency, ok: false })
    log('proxy', `检测失败 ${p.name} (${id})：${out.error}`)
    return { ok: false, error: out.error ?? '探测失败', proxy: getProxy(id), quality: judgeIpQuality(null) }
  }
  const { info, error } = parseExitInfo(out.body)
  if (!info) {
    saveProxyCheck(id, { ...BLANK_CHECK, latencyMs: latency, ok: false })
    return { ok: false, error: error ?? '无法解析出口信息', proxy: getProxy(id), quality: judgeIpQuality(null) }
  }
  // 出口信息本身能解析出来，就按它判定质量：连通性 OK 但出口是机房，
  // 对用户来说同样是「这个代理不能用来登账号」。
  const quality = judgeIpQuality(info)
  saveProxyCheck(id, {
    ...info,
    quality: quality.quality,
    qualityScore: quality.score,
    qualityIssues: quality.issues,
    latencyMs: latency,
    ok: true
  })
  log(
    'proxy',
    `检测通过 ${p.name} (${id}) 出口=${info.ip} 质量=${quality.quality}(${quality.score}) 延迟=${latency}ms${
      quality.issues.length ? ` 问题=${quality.issues.join('；')}` : ''
    }`
  )
  return { ok: true, error: null, proxy: getProxy(id), quality }
}

/** 批量检测：并发受限，避免一次性打爆代理或出口服务 */
export async function checkAll(ids?: string[]): Promise<{ ok: number; failed: { id: string; error: string }[] }> {
  const targets = ids?.length ? ids : listProxies().map((p) => p.id)
  const failed: { id: string; error: string }[] = []
  let ok = 0
  const queue = [...targets]
  const limit = Math.max(1, typedSetting<number>('proxy.checkConcurrency', 4))
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift()
      if (!id) return
      try {
        const r = await check(id)
        if (r.ok) ok++
        else failed.push({ id, error: r.error ?? '未知原因' })
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  })
  await Promise.all(workers)
  return { ok, failed }
}

export function remove(id: string): { deleted: boolean; unbound: number } {
  const p = getProxy(id)
  if (!p) return { deleted: false, unbound: 0 }
  const bound = boundProfiles(id)
  // 正在运行的环境不能悄悄失去代理，否则用户以为还在原出口
  const running = bound.filter((b) => getSession(b.id))
  if (running.length) {
    throw new Error(`有 ${running.length} 个绑定该代理的环境正在运行，请先关闭`)
  }
  deleteProxy(id)
  log('proxy', `删除代理 ${p.name} (${id})，移入回收站，解除 ${bound.length} 个环境绑定`)
  return { deleted: true, unbound: bound.length }
}

/** 回收站列表 */
export function trash(): ProxyRecord[] {
  return listTrashProxies()
}

/** 从回收站恢复 */
export function restore(id: string): void {
  restoreProxy(id)
}

/** 彻底删除（不可恢复） */
export function purge(id: string): void {
  purgeProxy(id)
}

/** 清空代理回收站 */
export function emptyTrash(): number {
  return emptyTrashProxies()
}

export interface ImportResult {
  imported: number
  skipped: { line: string; reason: string }[]
}

export function importText(text: string): ImportResult {
  const skipped: ImportResult['skipped'] = []
  let imported = 0
  const seen = new Set(listProxies().map((p) => `${p.scheme}|${p.host}|${p.port}`))
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  for (const line of lines) {
    try {
      const v = validateProxyInput(parseProxyLine(line))
      const key = `${v.scheme}|${v.host}|${v.port}`
      if (seen.has(key)) {
        skipped.push({ line, reason: '重复（已存在或本次已导入）' })
        continue
      }
      seen.add(key)
      createProxy({ ...v, password: v.password ?? null })
      imported++
    } catch (e) {
      skipped.push({ line, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  log('proxy', `导入代理：成功 ${imported}，跳过 ${skipped.length}`)
  return { imported, skipped }
}
