import { listProfiles, getProfile } from '../db/repositories/profiles'
import { validateProfileFingerprint } from './profiles'
import { checkAssociation, checkProfile, sliceAssociation } from './association'
import { statsAll } from './session'
import { log } from '../lib/log'
import type { AssociationReport } from '@shared/association'
import type { Profile, ProxyRecord } from '@shared/types'
import type { SessionStats } from '@shared/session'
import type { HealthFactor, HealthLevel, HealthSummary, ProfileHealth } from '@shared/ops'

/**
 * 环境健康度：把分散在各模块的信号汇总成一个一眼能看懂的分数 + 问题清单。
 *
 * 四个维度：
 * 1. 指纹一致性（validateProfileFingerprint 的 score）
 * 2. 代理质量（绑定代理的 quality / checkedOk / 是否机房 IP）
 * 3. 登录态新鲜度（ageDays / daysLeft）
 * 4. 关联风险（checkProfile 的 score）
 *
 * 纯读取聚合，不触发任何真实内核操作，所以可以廉价地批量跑。
 */

export function levelFromScore(score: number): HealthLevel {
  if (score >= 80) return 'good'
  if (score >= 50) return 'warn'
  return 'bad'
}

export function proxyFactor(proxy: ProxyRecord | null, proxyMode: string): HealthFactor {
  if (proxyMode !== 'bind' || !proxy) {
    return { key: 'proxy', label: '代理', level: 'warn', score: 50, message: '直连（未绑定代理）' }
  }
  if (proxy.checkedOk === 0) {
    return { key: 'proxy', label: '代理', level: 'bad', score: 0, message: `代理检测失败：${proxy.host}:${proxy.port}` }
  }
  if (proxy.hosting) {
    return { key: 'proxy', label: '代理', level: 'bad', score: 20, message: `机房 IP（${proxy.isp ?? proxy.asName ?? 'IDC'}），高风险被识别` }
  }
  if (proxy.proxyExit) {
    return { key: 'proxy', label: '代理', level: 'warn', score: 55, message: '匿名代理 / VPN 出口' }
  }
  if (proxy.quality === 'residential' || proxy.quality === 'mobile') {
    return { key: 'proxy', label: '代理', level: 'good', score: 95, message: `${proxy.quality} 出口 · ${proxy.country ?? '?'}` }
  }
  if (proxy.lastCheckedAt === null) {
    return { key: 'proxy', label: '代理', level: 'warn', score: 60, message: '代理未检测' }
  }
  return { key: 'proxy', label: '代理', level: 'warn', score: 70, message: `出口 ${proxy.quality ?? '未知'} · ${proxy.country ?? '?'}` }
}

export function sessionFactor(stats: { ageDays: number; daysLeft: number | null; cookieCount: number } | undefined): HealthFactor {
  if (!stats) return { key: 'session', label: '登录态', level: 'good', score: 100, message: '无登录态（干净环境）' }
  if (stats.cookieCount === 0) return { key: 'session', label: '登录态', level: 'good', score: 100, message: '无 cookie' }
  if (stats.daysLeft !== null && stats.daysLeft <= 0) {
    return { key: 'session', label: '登录态', level: 'bad', score: 10, message: `登录态已过期（${stats.ageDays} 天未用）` }
  }
  if (stats.daysLeft !== null && stats.daysLeft <= 3) {
    return { key: 'session', label: '登录态', level: 'warn', score: 55, message: `登录态 ${stats.daysLeft} 天后到期` }
  }
  return { key: 'session', label: '登录态', level: 'good', score: 90, message: `${stats.cookieCount} 个 cookie · ${stats.ageDays} 天前` }
}

/** 综合分：四个因子加权平均（指纹与关联权重更高）。纯函数，便于单测。 */
export const HEALTH_WEIGHTS: Record<string, number> = { fingerprint: 1.2, proxy: 1.0, session: 0.6, association: 1.2 }

export function combineFactorScores(factors: { key: string; score: number }[]): number {
  let sum = 0
  let wsum = 0
  for (const f of factors) {
    const w = HEALTH_WEIGHTS[f.key] ?? 1
    sum += (f.score ?? 0) * w
    wsum += w
  }
  return wsum === 0 ? 0 : Math.round(sum / wsum)
}

export function profileHealth(profileId: string): ProfileHealth | null {
  const p = getProfile(profileId)
  if (!p) return null
  return buildHealth(p)
}

/**
 * 用已经装配好的 profile 构造健康度。
 *
 * 之前 profileHealth 内部每次都 listProfiles({limit:100000}) + statsAll()，
 * summary() 又对每个环境调一次 profileHealth —— 于是 N 个环境是 O(N²)：
 * 100 个环境要跑 100 次全量环境扫描、100 次全量登录态统计、100 次全量关联分析。
 * 现在 summary 只装配一次，把结果传进来复用。
 */
function buildHealth(
  p: Profile,
  precomputed?: { assoc: AssociationReport; sess: SessionStats | undefined }
): ProfileHealth | null {
  const fpReport = validateProfileFingerprint(p.id)
  const assoc = precomputed?.assoc ?? checkProfile(p.id)
  const sess = precomputed ? precomputed.sess : statsAll().find((s) => s.profileId === p.id)

  const factors: HealthFactor[] = [
    fpReport
      ? { key: 'fingerprint', label: '指纹一致性', level: levelFromScore(fpReport.score), score: fpReport.score, message: fpReport.errors ? `${fpReport.errors} 处矛盾` : fpReport.warns ? `${fpReport.warns} 处警告` : '一致' }
      : { key: 'fingerprint', label: '指纹一致性', level: 'warn', score: 50, message: '无指纹配置' },
    proxyFactor(p.proxy, p.proxyMode),
    sessionFactor(sess),
    { key: 'association', label: '关联风险', level: levelFromScore(assoc.score), score: assoc.score, message: assoc.errors ? `${assoc.errors} 项严重` : assoc.warns ? `${assoc.warns} 项警告` : '无关联风险' }
  ]

  // 综合分：四个因子加权平均（指纹与关联权重更高）
  const score = combineFactorScores(factors.map((f) => ({ key: f.key, score: f.score ?? 0 })))

  return {
    profileId: p.id,
    name: p.name,
    score,
    level: levelFromScore(score),
    factors,
    checkedAt: Date.now()
  }
}

export function summary(): HealthSummary {
  // 一次性装配：全量环境、全量登录态统计、全量关联分析各跑一次，
  // 再按环境复用。之前每个环境都重新跑一遍全量，是 O(N²)。
  const profiles = listProfiles({ limit: 100000 }).items
  const allStats = statsAll()
  const statsById = new Map(allStats.map((s) => [s.profileId, s]))
  const assocAll = checkAssociation()

  const items: ProfileHealth[] = []
  for (const p of profiles) {
    const h = buildHealth(p, { assoc: sliceAssociation(assocAll, p.id), sess: statsById.get(p.id) })
    if (h) items.push(h)
  }
  items.sort((a, b) => a.score - b.score)
  const good = items.filter((i) => i.level === 'good').length
  const warn = items.filter((i) => i.level === 'warn').length
  const bad = items.filter((i) => i.level === 'bad').length
  log('health', `健康度汇总：${items.length} 个环境（好 ${good} / 警 ${warn} / 差 ${bad}）`)
  return { total: items.length, good, warn, bad, items, checkedAt: Date.now() }
}
