import { describe, it, expect } from 'vitest'
import {
  analyzeAssociation,
  blockingIssues,
  DEFAULT_LIMITS,
  type AssocAccount,
  type AssocProfile,
  type AssocProxy
} from '../../src/main/association/rules'
import { signalKeyOf } from '../../src/main/association/signal'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import type { AssociationIssue } from '@shared/association'

/**
 * 关联隔离规则单测。
 *
 * 这一层的价值不在于「单个指纹像不像人」，而在于「一批环境放在一起会不会互相出卖」，
 * 所以测试全部用合成三元组，验证每条红线都能被抓到、且不误报健康配置。
 */

const NOW = Date.UTC(2026, 9, 5)
const DAY = 24 * 60 * 60 * 1000

const profile = (over: Partial<AssocProfile> & { id: string }): AssocProfile => ({
  name: over.id,
  proxyId: null,
  proxyMode: 'none',
  fingerprintSeed: `seed-${over.id}`,
  signalKey: `sig-${over.id}`,
  timezoneId: 'America/Los_Angeles',
  language: 'en-US',
  archived: false,
  ...over
})

const proxy = (over: Partial<AssocProxy> & { id: string }): AssocProxy => ({
  name: over.id,
  ip: `10.0.0.${over.id}`,
  country: 'US',
  quality: 'residential',
  hosting: false,
  isProxy: false,
  mobile: false,
  ...over
})

const account = (over: Partial<AssocAccount> & { id: string; username: string }): AssocAccount => ({
  platform: 'google',
  profileId: null,
  createdProfileId: null,
  lastUsedAt: NOW,
  createdAt: NOW - 30 * DAY,
  ...over
})

const codes = (issues: AssociationIssue[]): string[] => issues.map((i) => i.code).sort()

describe('关联隔离规则', () => {
  it('健康的「一环境一住宅代理一账号」：零风险，满分', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1', proxyMode: 'bind', proxyId: 'x1', timezoneId: 'America/Los_Angeles' })],
      [proxy({ id: 'x1', ip: '1.2.3.4', country: 'US' })],
      [account({ id: 'a1', username: 'me@gmail.com', profileId: 'p1', createdProfileId: 'p1' })],
      {},
      NOW
    )
    expect(report.issues.map((i) => i.code)).toEqual([])
    expect(report.score).toBe(100)
    expect(report.stats.maxAccountsPerIp).toBe(1)
    expect(report.stats.proxies).toBe(1)
  })

  it('两个环境共用同一个指纹 seed → 致命（噪声完全相同）', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1', fingerprintSeed: 'same' }), profile({ id: 'p2', fingerprintSeed: 'same' })],
      [],
      [],
      {},
      NOW
    )
    expect(codes(report.issues)).toContain('FINGERPRINT_DUPLICATE')
    expect(blockingIssues(report)).toHaveLength(1)
    expect(report.issues.find((i) => i.code === 'FINGERPRINT_DUPLICATE')!.profileIds.sort()).toEqual(['p1', 'p2'])
  })

  it('seed 不同但关键信号完全一致 → 警告（撞库概率接近同一指纹）', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1', signalKey: 'same' }), profile({ id: 'p2', signalKey: 'same' })],
      [],
      [],
      {},
      NOW
    )
    expect(codes(report.issues)).toContain('FINGERPRINT_COLLISION')
    expect(blockingIssues(report)).toHaveLength(0)
  })

  it('同一账号绑到两个环境 → 致命（换设备登录 + 连坐）', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1' }), profile({ id: 'p2' })],
      [],
      [
        account({ id: 'a1', username: 'Me@Gmail.COM', profileId: 'p1' }),
        account({ id: 'a2', username: 'me@gmail.com', profileId: 'p2' })
      ],
      {},
      NOW
    )
    const hit = report.issues.find((i) => i.code === 'ACCOUNT_MULTI_PROFILE')
    expect(hit).toBeTruthy()
    expect(hit!.level).toBe('error')
    // 用户名比对不区分大小写：Me@Gmail.COM 与 me@gmail.com 是同一个账号
    expect(hit!.accountIds.sort()).toEqual(['a1', 'a2'])
  })

  it('账号从注册环境迁到别的环境 → 警告（视为换设备）', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1' }), profile({ id: 'p2' })],
      [],
      [account({ id: 'a1', username: 'u@x.com', profileId: 'p2', createdProfileId: 'p1' })],
      {},
      NOW
    )
    expect(codes(report.issues)).toContain('ACCOUNT_PROFILE_MOVED')
  })

  it('数据中心 IP 承载账号 → 致命；代理/VPN 出口 → 警告', () => {
    const mk = (over: Partial<AssocProxy>): AssociationIssue[] =>
      analyzeAssociation(
        [profile({ id: 'p1', proxyMode: 'bind', proxyId: 'x1' })],
        [proxy({ id: 'x1', ip: '9.9.9.9', country: 'US', ...over })],
        [account({ id: 'a1', username: 'u@x.com', profileId: 'p1' })],
        {},
        NOW
      ).issues

    expect(codes(mk({ hosting: true, quality: 'datacenter' }))).toContain('IP_HOSTING_WITH_ACCOUNT')
    expect(codes(mk({ isProxy: true, quality: 'anonymizer' }))).toContain('IP_PROXY_WITH_ACCOUNT')
    expect(codes(mk({}))).toEqual([])
  })

  it('代理还没有出口检测结果 → 警告（无法确认出口与指纹所在地一致）', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1', proxyMode: 'bind', proxyId: 'x1' })],
      [proxy({ id: 'x1', ip: null })],
      [account({ id: 'a1', username: 'u@x.com', profileId: 'p1' })],
      {},
      NOW
    )
    expect(codes(report.issues)).toContain('IP_UNVERIFIED')
  })

  it('时区与出口国家矛盾 → 警告；不认识的国家不下结论', () => {
    const run = (tz: string, country: string): string[] =>
      codes(
        analyzeAssociation(
          [profile({ id: 'p1', proxyMode: 'bind', proxyId: 'x1', timezoneId: tz })],
          [proxy({ id: 'x1', ip: '1.2.3.4', country })],
          [account({ id: 'a1', username: 'u@x.com', profileId: 'p1' })],
          {},
          NOW
        ).issues
      )
    expect(run('Asia/Shanghai', 'US')).toContain('TZ_COUNTRY_MISMATCH')
    expect(run('America/Los_Angeles', 'US')).toEqual([])
    expect(run('Asia/Shanghai', 'XX')).toEqual([])
  })

  it('同一出口 IP 账号数超上限 → 致命，并列出涉及的环境', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1', proxyMode: 'bind', proxyId: 'x1' }), profile({ id: 'p2', proxyMode: 'bind', proxyId: 'x1' })],
      [proxy({ id: 'x1', ip: '1.2.3.4', country: 'US' })],
      [
        account({ id: 'a1', username: 'a@x.com', profileId: 'p1' }),
        account({ id: 'a2', username: 'b@x.com', profileId: 'p1' }),
        account({ id: 'a3', username: 'c@x.com', profileId: 'p2' }),
        account({ id: 'a4', username: 'd@x.com', profileId: 'p2' })
      ],
      { maxAccountsPerProxy: 99, maxAccountsPerIp: 3 },
      NOW
    )
    const hit = report.issues.find((i) => i.code === 'IP_ACCOUNT_LIMIT')
    expect(hit).toBeTruthy()
    expect(hit!.message).toContain('4 个账号')
    expect(report.stats.maxAccountsPerIp).toBe(4)
  })

  it('多个环境都直连 → 警告（共用本机出口）', () => {
    const report = analyzeAssociation(
      [profile({ id: 'p1' }), profile({ id: 'p2' })],
      [],
      [account({ id: 'a1', username: 'a@x.com', profileId: 'p1' }), account({ id: 'a2', username: 'b@x.com', profileId: 'p2' })],
      {},
      NOW
    )
    expect(codes(report.issues)).toContain('ACCOUNT_NO_PROXY')
    expect(report.stats.directConnectProfiles).toBe(2)
  })

  it('休眠账号 → info；归档环境不参与判定', () => {
    const report = analyzeAssociation(
      [
        profile({ id: 'p1' }),
        profile({ id: 'p2', fingerprintSeed: 'same' }),
        profile({ id: 'p3', fingerprintSeed: 'same', archived: true })
      ],
      [],
      [account({ id: 'a1', username: 'u@x.com', profileId: 'p1', lastUsedAt: NOW - 200 * DAY })],
      {},
      NOW
    )
    expect(codes(report.issues)).toContain('ACCOUNT_DORMANT')
    // p3 已归档，不该和 p2 一起被判指纹重复
    expect(codes(report.issues)).not.toContain('FINGERPRINT_DUPLICATE')
  })

  it('未被使用的代理与没有账号的环境 → info 提示；score 按权重递减', () => {
    const report = analyzeAssociation([profile({ id: 'p1' })], [proxy({ id: 'x1' })], [], {}, NOW)
    expect(codes(report.issues)).toEqual(['NO_ACCOUNTS', 'PROXY_UNUSED'])
    expect(report.score).toBe(98)
    expect(report.limits).toEqual(DEFAULT_LIMITS)
  })

  it('上限可被设置覆盖', () => {
    const profiles = [
      profile({ id: 'p1', proxyMode: 'bind', proxyId: 'x1' }),
      profile({ id: 'p2', proxyMode: 'bind', proxyId: 'x1' })
    ]
    const proxies = [proxy({ id: 'x1', ip: '1.2.3.4', country: 'US' })]
    const accounts = [account({ id: 'a1', username: 'a@x.com', profileId: 'p1' }), account({ id: 'a2', username: 'b@x.com', profileId: 'p2' })]
    expect(codes(analyzeAssociation(profiles, proxies, accounts, {}, NOW).issues)).toContain('PROXY_SHARED')
    expect(codes(analyzeAssociation(profiles, proxies, accounts, { maxAccountsPerProxy: 2 }, NOW).issues)).not.toContain('PROXY_SHARED')
  })
})

describe('指纹关键信号摘要', () => {
  const base = generateFingerprint({
    seed: 'sig-a',
    os: 'macOS',
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    kernelVersion: '132.0.6834.110'
  })

  it('信号相同则摘要相同，即使 seed 不同（所以必须按信号比对）', () => {
    const other = generateFingerprint({
      seed: 'sig-b',
      os: 'macOS',
      locale: 'en-US',
      timezone: 'America/Los_Angeles',
      kernelVersion: '132.0.6834.110'
    })
    // 生成器按 seed 决定 UA/屏幕/WebGL，这里显式把关键信号对齐来验证摘要本身
    const cloned = structuredClone(other)
    cloned.ua = structuredClone(base.ua)
    cloned.screen = structuredClone(base.screen)
    cloned.webgl = structuredClone(base.webgl)
    cloned.hardware = structuredClone(base.hardware)
    cloned.clientHints = structuredClone(base.clientHints)
    expect(cloned.seed).not.toBe(base.seed)
    expect(signalKeyOf(cloned)).toBe(signalKeyOf(base))
  })

  it('任一关键信号变化都会改变摘要', () => {
    const a = signalKeyOf(base)
    const tzChanged = structuredClone(base)
    tzChanged.timezone.id = 'Asia/Tokyo'
    expect(signalKeyOf(tzChanged)).not.toBe(a)

    const glChanged = structuredClone(base)
    glChanged.webgl.renderer = 'Apple M9'
    expect(signalKeyOf(glChanged)).not.toBe(a)

    const screenChanged = structuredClone(base)
    screenChanged.screen.height += 1
    expect(signalKeyOf(screenChanged)).not.toBe(a)
  })

  it('无指纹配置时返回 null，规则层会跳过这一项', () => {
    expect(signalKeyOf(null)).toBeNull()
  })
})