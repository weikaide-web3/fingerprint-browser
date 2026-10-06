import type { AssociationIssue, AssociationLevel, AssociationReport, AssociationStats } from '@shared/association'

/**
 * 关联风险规则（纯函数，不碰数据库，因此可以用合成数据做完整单测）。
 *
 * 输入是三个扁平列表 + 上限配置，输出是带定位信息的风险清单。
 * 服务层只负责把库里的行变成这些结构，规则本身保持可测、可复用
 * （界面、API、批量执行前检查都用同一份判定，不会出现「界面说安全、脚本照跑」）。
 */

export interface AssocProfile {
  id: string
  name: string
  proxyId: string | null
  proxyMode: 'bind' | 'none'
  /** 指纹种子：同种子意味着噪声完全相同 */
  fingerprintSeed: string | null
  /** 关键信号摘要（不含 seed）：用于抓「seed 不同但信号完全一样」 */
  signalKey: string | null
  timezoneId: string | null
  language: string | null
  archived: boolean
}

export interface AssocProxy {
  id: string
  name: string
  ip: string | null
  country: string | null
  quality: string | null
  hosting: boolean
  isProxy: boolean
  mobile: boolean
}

export interface AssocAccount {
  id: string
  platform: string
  username: string
  profileId: string | null
  /** 账号在哪个环境注册的；为空表示历史数据未知 */
  createdProfileId: string | null
  lastUsedAt: number | null
  createdAt: number
}

export interface AssocLimits {
  /** 一个代理最多给多少个环境用（商用实践是 1） */
  maxAccountsPerProxy: number
  /** 同一个出口 IP 最多承载多少个账号 */
  maxAccountsPerIp: number
  /** 超过多少天没使用算「休眠账号」（信誉衰减） */
  dormantDays: number
}

export const DEFAULT_LIMITS: AssocLimits = {
  maxAccountsPerProxy: 1,
  maxAccountsPerIp: 3,
  dormantDays: 90
}

const DAY = 24 * 60 * 60 * 1000

function issue(
  level: AssociationLevel,
  code: string,
  message: string,
  ids: { profileIds?: string[]; proxyIds?: string[]; accountIds?: string[] }
): AssociationIssue {
  return {
    level,
    code,
    message,
    profileIds: ids.profileIds ?? [],
    proxyIds: ids.proxyIds ?? [],
    accountIds: ids.accountIds ?? []
  }
}

const short = (v: string, n = 24): string => (v.length > n ? `${v.slice(0, n)}…` : v)

export function analyzeAssociation(
  profiles: AssocProfile[],
  proxies: AssocProxy[],
  accounts: AssocAccount[],
  limits: Partial<AssocLimits> = {},
  now = Date.now()
): AssociationReport {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const issues: AssociationIssue[] = []
  const live = profiles.filter((p) => !p.archived)
  const proxyById = new Map(proxies.map((p) => [p.id, p]))
  const profileById = new Map(profiles.map((p) => [p.id, p]))
  const accountsOfProfile = new Map<string, AssocAccount[]>()
  for (const a of accounts) {
    if (!a.profileId) continue
    const list = accountsOfProfile.get(a.profileId) ?? []
    list.push(a)
    accountsOfProfile.set(a.profileId, list)
  }

  // ---------- 1. 环境没有代理但有账号：所有账号共用本机出口 ----------
  const direct = live.filter((p) => (p.proxyMode !== 'bind' || !p.proxyId) && (accountsOfProfile.get(p.id)?.length ?? 0) > 0)
  for (const p of direct) {
    const acc = accountsOfProfile.get(p.id) ?? []
    issues.push(
      issue(
        'warn',
        'ACCOUNT_NO_PROXY',
        `环境「${p.name}」里的 ${acc.length} 个账号走本机直连出口：多个环境都直连时，所有账号共用同一个住宅 IP`,
        { profileIds: [p.id], accountIds: acc.map((a) => a.id) }
      )
    )
  }

  // ---------- 2. 一个代理被多个环境共用 ----------
  const profilesByProxy = new Map<string, AssocProfile[]>()
  for (const p of live) {
    if (p.proxyMode !== 'bind' || !p.proxyId) continue
    const list = profilesByProxy.get(p.proxyId) ?? []
    list.push(p)
    profilesByProxy.set(p.proxyId, list)
  }
  let sharedProxies = 0
  for (const [proxyId, list] of profilesByProxy) {
    if (list.length <= lim.maxAccountsPerProxy) continue
    sharedProxies += 1
    const proxy = proxyById.get(proxyId)
    const names = list.map((p) => p.name)
    // 住宅 IP 共用还能解释成同一家庭网络，数据中心 IP 共用就是典型的批量操作特征
    const level: AssociationLevel = proxy?.hosting || proxy?.isProxy ? 'error' : 'warn'
    issues.push(
      issue(
        level,
        'PROXY_SHARED',
        `代理「${proxy?.name ?? proxyId}」被 ${list.length} 个环境共用（上限 ${lim.maxAccountsPerProxy}）：${names.join('、')}${proxy?.hosting ? '；且该出口是数据中心 IP，共用即批量特征' : ''}`,
        { profileIds: list.map((p) => p.id), proxyIds: [proxyId] }
      )
    )
  }

  // ---------- 3. 指纹重复：同 seed 或关键信号完全一致 ----------
  const bySeed = new Map<string, AssocProfile[]>()
  for (const p of live) {
    if (!p.fingerprintSeed) continue
    const list = bySeed.get(p.fingerprintSeed) ?? []
    list.push(p)
    bySeed.set(p.fingerprintSeed, list)
  }
  for (const [seed, list] of bySeed) {
    if (list.length < 2) continue
    issues.push(
      issue(
        'error',
        'FINGERPRINT_DUPLICATE',
        `${list.length} 个环境使用同一个指纹种子 ${short(seed, 16)}：Canvas / Audio / WebGL 噪声完全相同，服务端可直接判定为同一设备（${list.map((p) => p.name).join('、')}）`,
        { profileIds: list.map((p) => p.id) }
      )
    )
  }
  const bySignal = new Map<string, AssocProfile[]>()
  for (const p of live) {
    if (!p.signalKey) continue
    const list = bySignal.get(p.signalKey) ?? []
    list.push(p)
    bySignal.set(p.signalKey, list)
  }
  for (const [, list] of bySignal) {
    if (list.length < 2) continue
    // seed 不同但信号一致，说明两边都是默认值/同一预设，撞库概率很高
    const seeds = new Set(list.map((p) => p.fingerprintSeed))
    if (seeds.size < 2) continue
    issues.push(
      issue(
        'warn',
        'FINGERPRINT_COLLISION',
        `${list.length} 个环境指纹种子不同但关键信号完全一致（UA/屏幕/WebGL/时区/语言全同）：${list.map((p) => p.name).join('、')}，实际撞库概率接近同一指纹`,
        { profileIds: list.map((p) => p.id) }
      )
    )
  }

  // ---------- 4. 同一账号出现在多个环境 ----------
  const accountsByKey = new Map<string, AssocAccount[]>()
  for (const a of accounts) {
    const key = `${a.platform}|${a.username.toLowerCase()}`
    const list = accountsByKey.get(key) ?? []
    list.push(a)
    accountsByKey.set(key, list)
  }
  for (const [key, list] of accountsByKey) {
    const pids = [...new Set(list.map((a) => a.profileId).filter((v): v is string => Boolean(v)))]
    if (pids.length < 2) continue
    const [, username] = key.split('|')
    issues.push(
      issue(
        'error',
        'ACCOUNT_MULTI_PROFILE',
        `账号「${username}」被绑定到 ${pids.length} 个环境：同一账号在多个设备出现是 Google / X 的高危信号，一个环境出问题其余连坐`,
        { profileIds: pids, accountIds: list.map((a) => a.id) }
      )
    )
  }

  // ---------- 5. 账号注册环境与当前环境不一致 ----------
  for (const a of accounts) {
    if (!a.createdProfileId || !a.profileId || a.createdProfileId === a.profileId) continue
    const from = profileById.get(a.createdProfileId)
    const to = profileById.get(a.profileId)
    if (!from || !to) continue
    issues.push(
      issue(
        'warn',
        'ACCOUNT_PROFILE_MOVED',
        `账号「${a.username}」在环境「${from.name}」注册，现在绑定到「${to.name}」：服务端会视为换设备登录，大概率触发二次验证`,
        { profileIds: [from.id, to.id], accountIds: [a.id] }
      )
    )
  }

  // ---------- 6. 出口质量：数据中心 / 已知代理 IP 上跑账号 ----------
  for (const p of live) {
    const acc = accountsOfProfile.get(p.id) ?? []
    if (!acc.length) continue
    if (p.proxyMode !== 'bind' || !p.proxyId) continue
    const proxy = proxyById.get(p.proxyId)
    if (!proxy) continue
    if (proxy.hosting) {
      issues.push(
        issue(
          'error',
          'IP_HOSTING_WITH_ACCOUNT',
          `环境「${p.name}」的出口「${proxy.name}」是数据中心 IP（${proxy.ip ?? '未知'}），却承载 ${acc.length} 个账号：Google 与 X 对机房段基本一票否决`,
          { profileIds: [p.id], proxyIds: [proxy.id], accountIds: acc.map((a) => a.id) }
        )
      )
    } else if (proxy.isProxy) {
      issues.push(
        issue(
          'warn',
          'IP_PROXY_WITH_ACCOUNT',
          `环境「${p.name}」的出口被标记为代理/VPN（${proxy.ip ?? '未知'}）：部分站点会降级验证或限制功能`,
          { profileIds: [p.id], proxyIds: [proxy.id], accountIds: acc.map((a) => a.id) }
        )
      )
    }
    if (!proxy.ip) {
      issues.push(
        issue(
          'warn',
          'IP_UNVERIFIED',
          `环境「${p.name}」绑定的代理「${proxy.name}」还没有可信的出口检测结果：无法确认实际出口与指纹所在地是否一致`,
          { profileIds: [p.id], proxyIds: [proxy.id] }
        )
      )
    }
  }

  // ---------- 7. 时区 / 语言与出口国家矛盾 ----------
  for (const p of live) {
    const acc = accountsOfProfile.get(p.id) ?? []
    if (!acc.length) continue
    if (p.proxyMode !== 'bind' || !p.proxyId) continue
    const proxy = proxyById.get(p.proxyId)
    if (!proxy?.country || !p.timezoneId) continue
    if (!timezoneMatchesCountry(p.timezoneId, proxy.country)) {
      issues.push(
        issue(
          'warn',
          'TZ_COUNTRY_MISMATCH',
          `环境「${p.name}」时区是 ${p.timezoneId}，但出口在 ${proxy.country}（${proxy.ip ?? '未知'}）：时区与 IP 所在地不一致是典型穿帮点`,
          { profileIds: [p.id], proxyIds: [proxy.id], accountIds: acc.map((a) => a.id) }
        )
      )
    }
  }

  // ---------- 8. 同一出口 IP 承载账号过多 ----------
  const ipStats = ipStatsOf(live, accountsOfProfile, proxyById)
  for (const [ip, list] of ipStats.ipAccounts) {
    if (list.length <= lim.maxAccountsPerIp) continue
    const pids = ipStats.ipProfiles.get(ip) ?? []
    const label = ip === 'DIRECT' ? '本机直连出口' : ip
    issues.push(
      issue(
        'error',
        'IP_ACCOUNT_LIMIT',
        `出口 ${label} 上共有 ${list.length} 个账号（上限 ${lim.maxAccountsPerIp}）：涉及环境 ${pids.map((id) => profileById.get(id)?.name ?? id).join('、')}，一个账号出问题整批连坐`,
        { profileIds: pids, accountIds: list.map((a) => a.id) }
      )
    )
  }

  // ---------- 9. 休眠账号：信誉会衰减 ----------
  for (const a of accounts) {
    if (!a.lastUsedAt) continue
    const days = Math.floor((now - a.lastUsedAt) / DAY)
    if (days <= lim.dormantDays) continue
    const p = a.profileId ? profileById.get(a.profileId) : undefined
    if (p?.archived) continue
    issues.push(
      issue(
        'info',
        'ACCOUNT_DORMANT',
        `账号「${a.username}」已 ${days} 天未使用（阈值 ${lim.dormantDays} 天）：长期不活跃的账号重新登录时更容易被要求验证`,
        { accountIds: [a.id], profileIds: a.profileId ? [a.profileId] : [] }
      )
    )
  }

  return finish(
    issues,
    live,
    accounts,
    ipStatsOf(live, accountsOfProfile, proxyById),
    lim,
    now,
    profilesByProxy,
    proxyById,
    accountsOfProfile,
    profileById,
    sharedProxies
  )
}

function usedProxiesOf(live: AssocProfile[]): Set<string> {
  return new Set(live.filter((p) => p.proxyMode === 'bind' && p.proxyId).map((p) => p.proxyId as string))
}

interface IpStats {
  ipAccountCount: Record<string, number>
  ipAccounts: Map<string, AssocAccount[]>
  ipProfiles: Map<string, string[]>
}

function ipStatsOf(
  live: AssocProfile[],
  accountsOfProfile: Map<string, AssocAccount[]>,
  proxyById: Map<string, AssocProxy>
): IpStats {
  const ipAccountCount: Record<string, number> = {}
  const ipAccounts = new Map<string, AssocAccount[]>()
  const ipProfiles = new Map<string, string[]>()
  for (const p of live) {
    const acc = accountsOfProfile.get(p.id) ?? []
    if (!acc.length) continue
    const proxy = p.proxyMode === 'bind' && p.proxyId ? proxyById.get(p.proxyId) : undefined
    const ip = proxy?.ip ?? (p.proxyMode === 'bind' ? null : 'DIRECT')
    if (!ip) continue
    ipAccountCount[ip] = (ipAccountCount[ip] ?? 0) + acc.length
    const list = ipAccounts.get(ip) ?? []
    list.push(...acc)
    ipAccounts.set(ip, list)
    const ps = ipProfiles.get(ip) ?? []
    ps.push(p.id)
    ipProfiles.set(ip, ps)
  }
  return { ipAccountCount, ipAccounts, ipProfiles }
}

/** 时区与出口国家是否说得通：US 出口 + Asia/Shanghai 时区是最常见的自相矛盾 */
const COUNTRY_TIMEZONES: Record<string, string[]> = {
  US: ['America/', 'US/'],
  CN: ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Urumqi', 'PRC'],
  JP: ['Asia/Tokyo'],
  KR: ['Asia/Seoul'],
  DE: ['Europe/Berlin', 'Europe/'],
  GB: ['Europe/London', 'GB-Eire'],
  HK: ['Asia/Hong_Kong'],
  TW: ['Asia/Taipei'],
  SG: ['Asia/Singapore'],
  IN: ['Asia/Kolkata', 'Asia/Calcutta', 'Asia/Kolkata'],
  RU: ['Europe/Moscow', 'Asia/'],
  BR: ['America/Sao_Paulo', 'America/'],
  CA: ['America/', 'Canada/'],
  AU: ['Australia/', 'America/'],
  FR: ['Europe/Paris', 'Europe/'],
  NL: ['Europe/Amsterdam', 'Europe/'],
  ID: ['Asia/Jakarta', 'Asia/'],
  PH: ['Asia/Manila', 'Asia/'],
  VN: ['Asia/Ho_Chi_Minh', 'Asia/'],
  TH: ['Asia/Bangkok', 'Asia/'],
  MY: ['Asia/Kuala_Lumpur', 'Asia/'],
  TR: ['Europe/Istanbul', 'Asia/'],
  UA: ['Europe/Kyiv', 'Europe/Kiev', 'Europe/'],
  PL: ['Europe/Warsaw', 'Europe/'],
  ES: ['Europe/Madrid', 'Europe/'],
  IT: ['Europe/Rome', 'Europe/'],
  SE: ['Europe/Stockholm', 'Europe/'],
  MX: ['America/Mexico_City', 'America/'],
  AR: ['America/Argentina/Buenos_Aires', 'America/']
}

function timezoneMatchesCountry(tz: string, country: string): boolean {
  const prefixes = COUNTRY_TIMEZONES[country]
  if (!prefixes) return true // 不认识的国家的不下结论，避免误报
  return prefixes.some((p) => tz.startsWith(p) || tz === p)
}

function finish(
  issues: AssociationIssue[],
  live: AssocProfile[],
  accounts: AssocAccount[],
  ipStats: IpStats,
  lim: AssocLimits,
  now: number,
  profilesByProxy: Map<string, AssocProfile[]>,
  proxyById: Map<string, AssocProxy>,
  accountsOfProfile: Map<string, AssocAccount[]>,
  profileById: Map<string, AssocProfile>,
  sharedProxies: number
): AssociationReport {
  // ---------- 10. 从未使用过的代理：说明配置没收敛，提示清理 ----------
  const used = usedProxiesOf(live)
  for (const proxy of proxyById.values()) {
    if (used.has(proxy.id)) continue
    if (profilesByProxy.has(proxy.id)) continue // 只被归档环境使用，另说
    issues.push(
      issue('info', 'PROXY_UNUSED', `代理「${proxy.name}」当前没有任何环境在使用：确认是备用还是配置遗漏`, {
        proxyIds: [proxy.id]
      })
    )
  }

  // ---------- 11. 没有任何账号的环境：不算风险，但批量场景下值得提示 ----------
  const emptyProfiles = live.filter((p) => (accountsOfProfile.get(p.id)?.length ?? 0) === 0)
  if (live.length > 0 && emptyProfiles.length === live.length) {
    issues.push(
      issue('info', 'NO_ACCOUNTS', '还没有任何环境绑定账号：关联隔离只在「环境-代理-账号」三元组建立后才有意义', {
        profileIds: live.map((p) => p.id)
      })
    )
  }

  const errors = issues.filter((i) => i.level === 'error').length
  const warns = issues.filter((i) => i.level === 'warn').length
  const infos = issues.filter((i) => i.level === 'info').length
  // error 权重最高：一个致命关联就能让整批账号连坐
  const score = Math.max(0, 100 - errors * 20 - warns * 6 - infos * 1)

  const ipAccountCount = ipStats.ipAccountCount
  const stats: AssociationStats = {
    profiles: live.length,
    accounts: accounts.length,
    proxies: used.size,
    ipAccountCount,
    maxAccountsPerIp: Object.values(ipAccountCount).reduce((m, n) => Math.max(m, n), 0),
    sharedProxies,
    directConnectProfiles: live.filter(
      (p) => (p.proxyMode !== 'bind' || !p.proxyId) && (accountsOfProfile.get(p.id)?.length ?? 0) > 0
    ).length
  }

  void profileById
  return { checkedAt: now, issues, errors, warns, infos, score, stats, limits: lim }
}

/**
 * 执行前检查用的精简版：只关心「这次操作会不会踩红线」。
 * 返回 error 级问题，调用方据此决定是否阻断。
 */
export function blockingIssues(report: AssociationReport): AssociationIssue[] {
  return report.issues.filter((i) => i.level === 'error')
}