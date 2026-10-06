import { describe, it, expect } from 'vitest'
import {
  levelFromScore,
  proxyFactor,
  sessionFactor,
  combineFactorScores,
  HEALTH_WEIGHTS
} from '../../src/main/services/health'
import { bundleFilename } from '../../src/main/services/port'
import type { ProxyRecord } from '../../src/shared/types'

function proxy(over: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    id: 'px1',
    name: 'p',
    scheme: 'http',
    host: '1.2.3.4',
    port: 8080,
    username: null,
    hasPassword: false,
    groupId: null,
    ip: null,
    country: null,
    region: null,
    city: null,
    isp: null,
    timezone: null,
    quality: null,
    qualityScore: null,
    qualityIssues: [],
    asn: null,
    asName: null,
    org: null,
    reverse: null,
    usageType: null,
    hosting: false,
    proxyExit: false,
    mobile: false,
    anycast: false,
    latencyMs: null,
    lastCheckedAt: null,
    checkedOk: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

describe('health.levelFromScore', () => {
  it('阈值边界：>=80 good，>=50 warn，否则 bad', () => {
    expect(levelFromScore(100)).toBe('good')
    expect(levelFromScore(80)).toBe('good')
    expect(levelFromScore(79)).toBe('warn')
    expect(levelFromScore(50)).toBe('warn')
    expect(levelFromScore(49)).toBe('bad')
    expect(levelFromScore(0)).toBe('bad')
  })
})

describe('health.proxyFactor', () => {
  it('未绑定代理 → warn（直连）', () => {
    const f = proxyFactor(null, 'none')
    expect(f.level).toBe('warn')
    expect(f.score).toBe(50)
  })
  it('检测失败 → bad', () => {
    const f = proxyFactor(proxy({ checkedOk: 0 }), 'bind')
    expect(f.level).toBe('bad')
    expect(f.score).toBe(0)
  })
  it('机房 IP → bad', () => {
    const f = proxyFactor(proxy({ hosting: true, checkedOk: 1 }), 'bind')
    expect(f.level).toBe('bad')
    expect(f.score).toBe(20)
  })
  it('匿名代理出口 → warn', () => {
    const f = proxyFactor(proxy({ proxyExit: true, checkedOk: 1 }), 'bind')
    expect(f.level).toBe('warn')
    expect(f.score).toBe(55)
  })
  it('住宅 / 移动出口 → good', () => {
    const f = proxyFactor(proxy({ quality: 'residential', checkedOk: 1, country: 'US' }), 'bind')
    expect(f.level).toBe('good')
    expect(f.score).toBe(95)
  })
  it('未检测 → warn', () => {
    const f = proxyFactor(proxy({ lastCheckedAt: null, checkedOk: null }), 'bind')
    expect(f.level).toBe('warn')
    expect(f.score).toBe(60)
  })
})

describe('health.sessionFactor', () => {
  it('无登录态 → good', () => {
    expect(sessionFactor(undefined).level).toBe('good')
    expect(sessionFactor({ ageDays: 0, daysLeft: null, cookieCount: 0 }).level).toBe('good')
  })
  it('已过期 → bad', () => {
    const f = sessionFactor({ ageDays: 30, daysLeft: 0, cookieCount: 5 })
    expect(f.level).toBe('bad')
    expect(f.score).toBe(10)
  })
  it('临近到期 → warn', () => {
    const f = sessionFactor({ ageDays: 1, daysLeft: 2, cookieCount: 5 })
    expect(f.level).toBe('warn')
    expect(f.score).toBe(55)
  })
  it('新鲜 → good', () => {
    const f = sessionFactor({ ageDays: 1, daysLeft: 30, cookieCount: 5 })
    expect(f.level).toBe('good')
    expect(f.score).toBe(90)
  })
})

describe('health.combineFactorScores', () => {
  it('空因子 → 0', () => {
    expect(combineFactorScores([])).toBe(0)
  })
  it('等权重平均（两个默认权重 key）', () => {
    expect(combineFactorScores([{ key: 'a', score: 100 }, { key: 'b', score: 0 }])).toBe(50)
  })
  it('按 HEALTH_WEIGHTS 加权：指纹/关联权重更高', () => {
    const s = combineFactorScores([{ key: 'fingerprint', score: 0 }, { key: 'proxy', score: 100 }])
    expect(s).toBe(Math.round((100 * HEALTH_WEIGHTS.proxy) / (HEALTH_WEIGHTS.fingerprint + HEALTH_WEIGHTS.proxy)))
    expect(s).toBe(45)
  })
  it('未知 key 默认权重 1', () => {
    expect(combineFactorScores([{ key: 'unknown', score: 80 }])).toBe(80)
  })
})

describe('port.bundleFilename', () => {
  it('清理非法字符并加前缀', () => {
    const f = bundleFilename('my/prof:ile')
    expect(f.startsWith('fpb-profile-my_prof_ile-')).toBe(true)
    expect(f.endsWith('.json')).toBe(true)
  })
  it('空名回退为 profile', () => {
    expect(bundleFilename('')).toContain('fpb-profile-profile-')
  })
  it('超长名截断到 80', () => {
    const long = 'a'.repeat(200)
    const f = bundleFilename(long)
    expect(f).toContain('a'.repeat(80))
    expect(f).not.toContain('a'.repeat(81))
  })
})
