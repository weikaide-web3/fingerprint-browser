import { describe, it, expect } from 'vitest'
import { judgeIpQuality, parseExitInfo, type ExitInfo } from '../../src/main/proxy/checker'

/**
 * 出口质量判定。
 *
 * 这一项的性价比最高：数据中心 IP 在 Google 与 X 都是一票否决，
 * 指纹做得再完美也救不回来，所以判定必须准且必须拦得住。
 */

function exit(patch: Partial<ExitInfo>): ExitInfo {
  return {
    ip: '203.0.113.10',
    country: 'US',
    region: 'California',
    city: 'Mountain View',
    isp: 'Some ISP',
    timezone: 'America/Los_Angeles',
    asn: 'AS7922',
    asName: 'Comcast Cable',
    org: 'Comcast Cable',
    reverse: 'cpe.comcast.net',
    usageType: 'ISP',
    hosting: false,
    isProxy: false,
    mobile: false,
    anycast: false,
    ...patch
  }
}

describe('出口质量判定', () => {
  it('没有任何出口信息时判为 unknown 并拦截', () => {
    expect(judgeIpQuality(null)).toMatchObject({ quality: 'unknown', blocked: true })
    expect(judgeIpQuality(exit({ ip: '' })).quality).toBe('unknown')
  })

  it('普通住宅 ISP 出口：满分且不拦截', () => {
    const v = judgeIpQuality(exit({}))
    expect(v.quality).toBe('residential')
    expect(v.score).toBe(100)
    expect(v.issues).toEqual([])
    expect(v.blocked).toBe(false)
  })

  it('机房出口：判为 datacenter 并拦截', () => {
    const v = judgeIpQuality(exit({ hosting: true, usageType: 'COM', isp: 'Peer1 US LLC' }))
    expect(v.quality).toBe('datacenter')
    expect(v.blocked).toBe(true)
    expect(v.issues.join(' ')).toContain('机房')
  })

  it('匿名代理 / VPN 出口：判为 anonymizer，扣分比机房更重', () => {
    const proxy = judgeIpQuality(exit({ isProxy: true }))
    const dc = judgeIpQuality(exit({ hosting: true }))
    expect(proxy.quality).toBe('anonymizer')
    expect(proxy.blocked).toBe(true)
    expect(proxy.score).toBeLessThan(dc.score)
  })

  it('蜂窝出口：判为 mobile 且不拦截', () => {
    const v = judgeIpQuality(exit({ mobile: true, usageType: 'MOBILE' }))
    expect(v.quality).toBe('mobile')
    expect(v.blocked).toBe(false)
  })

  it('反向 DNS 指向云厂商时即使 usageType 缺失也能识别为机房', () => {
    const v = judgeIpQuality(
      exit({ reverse: 'ec2-54-123-45-67.us-east-1.compute.amazonaws.com', usageType: null, isp: null, asn: null, asName: null })
    )
    expect(v.quality).toBe('datacenter')
    expect(v.blocked).toBe(true)
    expect(v.issues.join(' ')).toContain('反向 DNS')
  })

  it('探测点不返回用途信息时扣分并提示换探测点', () => {
    const v = judgeIpQuality(
      exit({ usageType: null, reverse: null, isp: null, asn: null, asName: null, org: null })
    )
    expect(v.issues.join(' ')).toContain('未返回用途信息')
    expect(v.score).toBeLessThan(100)
  })

  it('anycast 只扣分，不改变住宅判定', () => {
    const v = judgeIpQuality(exit({ anycast: true }))
    expect(v.quality).toBe('residential')
    expect(v.blocked).toBe(false)
    expect(v.score).toBe(90)
  })

  it('得分始终落在 0-100', () => {
    for (const patch of [
      {},
      { hosting: true, isProxy: true, anycast: true, usageType: 'RESERVED', reverse: 'ip-1-2-3.vultr.com' },
      { mobile: true, anycast: true }
    ]) {
      const v = judgeIpQuality(exit(patch))
      expect(v.score).toBeGreaterThanOrEqual(0)
      expect(v.score).toBeLessThanOrEqual(100)
    }
  })

  it('解析 ip-api 风格响应时拆出 ASN 编号与名称', () => {
    const { info } = parseExitInfo(
      JSON.stringify({
        status: 'success',
        query: '66.87.99.10',
        country: 'US',
        regionName: 'Texas',
        city: 'Dallas',
        isp: 'Limestone Networks',
        usageType: 'COM',
        hosting: true,
        as: 'AS20473 Choopa, LLC',
        reverse: 'static.10.99.87.66.clients.limestone.net',
        mobile: false,
        proxy: false,
        anycast: false
      })
    )
    expect(info?.asn).toBe('AS20473')
    expect(info?.asName).toBe('Choopa, LLC')
    expect(info?.hosting).toBe(true)
    const v = judgeIpQuality(info)
    expect(v.quality).toBe('datacenter')
    expect(v.blocked).toBe(true)
  })
})

describe('判定信号缺失必须显式暴露', () => {
  it('探测点没返回 usageType/reverse 时，degraded 列出缺失字段', () => {
    // 免费版 ip-api 的真实响应就不含这几个字段 —— 不标出来的话，
    // 用户看到 residential 会以为已确认用途，实际只是「没数据所以没扣分」。
    const v = judgeIpQuality(
      exit({ usageType: null as unknown as string, anycast: false, reverse: null as unknown as string })
    )
    expect(v.degraded).toEqual(expect.arrayContaining(['usageType', 'reverse']))
    expect(v.issues.join(' ')).toMatch(/缺少信号/)
  })

  it('parseExitInfo 从响应里识别缺失字段', () => {
    // 模拟免费版 ip-api：没有 usageType / anycast / reverse
    const body = JSON.stringify({
      status: 'success',
      country: 'JP',
      query: '1.2.3.4',
      isp: 'Some ISP',
      as: 'AS1 Some AS',
      hosting: false,
      proxy: false,
      mobile: false
    })
    const { info } = parseExitInfo(body)
    expect(info).toBeTruthy()
    expect(info?.signalsMissing).toEqual(expect.arrayContaining(['usageType', 'anycast', 'reverse']))
    const v = judgeIpQuality(info as NonNullable<ReturnType<typeof parseExitInfo>['info']>)
    expect(v.degraded).toContain('usageType')
  })

  it('字段齐全时 degraded 为空', () => {
    const v = judgeIpQuality(exit({}))
    expect(v.degraded).toEqual([])
  })

  it('缺信号不会把机房出口误判成住宅（hosting=true 仍然拦截）', () => {
    const v = judgeIpQuality(
      exit({ hosting: true, usageType: null as unknown as string, anycast: false, reverse: null as unknown as string })
    )
    expect(v.quality).toBe('datacenter')
    expect(v.blocked).toBe(true)
  })
})
