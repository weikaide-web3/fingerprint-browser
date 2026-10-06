import { listProfiles } from '../db/repositories/profiles'
import { listProxies } from '../db/repositories/proxies'
import { listAccounts } from '../db/repositories/accounts'
import { typedSetting } from '../settings/defs'
import { signalKeyOf } from '../association/signal'
import {
  analyzeAssociation,
  blockingIssues,
  DEFAULT_LIMITS,
  type AssocAccount,
  type AssocLimits,
  type AssocProfile,
  type AssocProxy
} from '../association/rules'
import { log } from '../lib/log'
import type { AssociationIssue, AssociationReport } from '@shared/association'

/**
 * 关联隔离服务：把库里的环境 / 代理 / 账号变成规则层要的结构，跑一遍判定。
 *
 * 判定逻辑本身在 association/rules.ts（纯函数、可单测），这里只做数据装配，
 * 因此界面、API、RPA 运行前检查用的是同一份结论 —— 不会出现
 * 「界面显示有风险，脚本照样跑」这种分裂。
 */

function limits(): AssocLimits {
  return {
    maxAccountsPerProxy: typedSetting<number>('assoc.maxAccountsPerProxy', DEFAULT_LIMITS.maxAccountsPerProxy),
    maxAccountsPerIp: typedSetting<number>('assoc.maxAccountsPerIp', DEFAULT_LIMITS.maxAccountsPerIp),
    dormantDays: typedSetting<number>('assoc.dormantDays', DEFAULT_LIMITS.dormantDays)
  }
}

export function checkAssociation(): AssociationReport {
  const profiles: AssocProfile[] = listProfiles({ limit: 1000 }).items.map((p) => ({
    id: p.id,
    name: p.name,
    proxyId: p.proxyId,
    proxyMode: p.proxyMode,
    fingerprintSeed: p.fingerprint?.seed ?? null,
    signalKey: signalKeyOf(p.fingerprint),
    timezoneId: p.fingerprint?.timezone.id ?? null,
    language: p.fingerprint?.language.languages[0] ?? null,
    archived: p.archived === 1
  }))
  const proxies: AssocProxy[] = listProxies().map((x) => ({
    id: x.id,
    name: x.name,
    ip: x.ip,
    country: x.country,
    quality: x.quality,
    hosting: x.hosting,
    isProxy: x.proxyExit,
    mobile: x.mobile
  }))
  const accounts: AssocAccount[] = listAccounts().map((a) => ({
    id: a.id,
    platform: a.platform,
    username: a.username,
    profileId: a.profileId,
    createdProfileId: a.createdProfileId,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt
  }))

  const report = analyzeAssociation(profiles, proxies, accounts, limits())
  if (report.errors) log('association', `关联风险：${report.errors} 个严重 / ${report.warns} 个警告，score=${report.score}`)
  return report
}

/**
 * 从一份全量报告里切出某个环境相关的部分。
 *
 * 导出给健康度汇总复用：summary() 跑一次全量分析，然后按环境切片，
 * 而不是每个环境都重新跑一遍全量（那是 O(N²)）。
 */
export function sliceAssociation(all: AssociationReport, profileId: string): AssociationReport {
  const ids = new Set(listAccounts(profileId).map((a) => a.id))
  const issues = all.issues.filter(
    (i) => i.profileIds.includes(profileId) || (i.accountIds.length > 0 && i.accountIds.some((id) => ids.has(id)))
  )
  const errors = issues.filter((i) => i.level === 'error').length
  const warns = issues.filter((i) => i.level === 'warn').length
  const infos = issues.filter((i) => i.level === 'info').length
  return {
    ...all,
    issues,
    errors,
    warns,
    infos,
    score: Math.max(0, 100 - errors * 20 - warns * 6 - infos * 1)
  }
}

/** 单个环境的关联视图：环境详情页用，避免为了看一行提示去跑全量 */
export function checkProfile(profileId: string): AssociationReport {
  return sliceAssociation(checkAssociation(), profileId)
}

/**
 * 运行前闸门：RPA / 批量操作启动前调用。
 * 返回 null 表示放行；否则返回要展示给用户的阻断原因。
 */
export function gateForRun(profileId: string, opts: { skip?: boolean } = {}): AssociationIssue[] | null {
  if (opts.skip) return null
  if (!typedSetting<boolean>('assoc.blockOnRun', true)) return null
  const report = checkProfile(profileId)
  const blocking = blockingIssues(report)
  return blocking.length ? blocking : null
}