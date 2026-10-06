/**
 * 关联隔离（环境 ↔ 代理 ↔ 账号 三元组）的共用契约。
 *
 * 为什么单独做这一层：Google 与 X 判定机器人时看的不是单个指纹，而是
 * 「账号-设备-出口」这个三元组的组合关系。两个环境各自指纹完美，
 * 但只要它们共用一个出口 IP、或同一个账号在两个环境登录过，
 * 服务端就能把这一批账号当成一个人操作 —— 一个被封，其余连坐。
 *
 * 所以这一层要回答的不是「这个环境像不像真人」，而是
 * 「这一批环境/代理/账号放在一起，会不会互相出卖」。
 */

export type AssociationLevel = 'error' | 'warn' | 'info'

export interface AssociationIssue {
  level: AssociationLevel
  /** 稳定标识，界面按它分组，也便于用户搜索解决办法 */
  code: string
  message: string
  /** 涉及的对象，界面据此提供跳转 */
  profileIds: string[]
  proxyIds: string[]
  accountIds: string[]
}

export interface AssociationStats {
  profiles: number
  accounts: number
  proxies: number
  /** 出口 IP -> 该 IP 下的账号数 */
  ipAccountCount: Record<string, number>
  maxAccountsPerIp: number
  /** 被 2 个以上环境共用的代理数 */
  sharedProxies: number
  /** 没有绑定代理、却有账号的环境数 */
  directConnectProfiles: number
}

export interface AssociationReport {
  checkedAt: number
  issues: AssociationIssue[]
  errors: number
  warns: number
  infos: number
  /** 0-100，100 = 没有已知关联风险 */
  score: number
  stats: AssociationStats
  /** 生效的上限配置 */
  limits: {
    maxAccountsPerProxy: number
    maxAccountsPerIp: number
    dormantDays: number
  }
}