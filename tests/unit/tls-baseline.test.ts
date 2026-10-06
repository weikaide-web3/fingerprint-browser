import { describe, it, expect } from 'vitest'
import { chromeMajor, compareTls, type TlsCompareInput } from '../../src/main/tls/baseline'
import type { Http2Fingerprint, TlsBaseline, TlsFingerprintView } from '@shared/tls'

/**
 * TLS 比对层单测。
 *
 * 这一层不碰网络，只回答「观测值说明了什么」。它最容易出的错是误报：
 * 把 Chrome 的正常行为（GREASE、扩展乱序）判成异常，用户就会去改
 * 一个根本没坏的东西。
 */

const view = (over: Partial<TlsFingerprintView> = {}): TlsFingerprintView => ({
  ja3: 'a'.repeat(32),
  ja3String: '771,0,0,0',
  ja3Stable: 'b'.repeat(32),
  ja3StableString: '771,10,29,23,24',
  ja3Sorted: 'c'.repeat(32),
  ja3SortedString: '771,10,23,24,29',
  extOrder: '0,10,11,35,16',
  ja4: 't13d1517h2_8daaf6152771_cb7bf5808d99',
  ja4r: 't13d1517h2_000010_000420',
  versionLabel: '13',
  sni: 'tls-probe.test',
  alpn: ['h2', 'http/1.1'],
  cipherCount: 15,
  extensionCount: 17,
  greaseCount: 6,
  ...over
})

const h2: Http2Fingerprint = {
  preface: true,
  settings: [
    { id: 2, value: 0 },
    { id: 3, value: 100 },
    { id: 4, value: 6291456 },
    { id: 1, value: 65536 }
  ],
  priorities: [],
  preludeFrames: [4, 0, 4],
  windowUpdate: 15663105,
  fp: 'S=2:0,3:100,4:6291456,1:65536;P=;A=4,0,4;W=15663105'
}

const baseline: TlsBaseline = {
  kernelVersion: '154.0.7610.0',
  chromeMajor: 154,
  ja3: 'a'.repeat(32),
  ja3Stable: 'b'.repeat(32),
  ja3Sorted: 'c'.repeat(32),
  ja4: 't13d1517h2_8daaf6152771_cb7bf5808d99',
  ja4r: 't13d1517h2_000010_000420',
  h2fp: h2.fp,
  cipherCount: 15,
  extensionCount: 17,
  greaseCount: 6,
  samples: 5,
  observedAt: 0
}

const input = (over: Partial<TlsCompareInput> = {}): TlsCompareInput => ({
  tls: view(),
  h2,
  baseline,
  declaredMajor: 154,
  kernelVersion: '154.0.7610.0',
  host: 'tls-probe.test',
  echo: null,
  ...over
})

const byKey = (items: ReturnType<typeof compareTls>, key: string) => items.find((i) => i.key === key)

describe('chromeMajor', () => {
  it('从整条 UA 里取 Chrome 主版本，而不是命中 Mozilla/5.0', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
    expect(chromeMajor(ua)).toBe(154)
  })

  it('纯版本号照常解析；Edge / iOS Chrome 也认', () => {
    expect(chromeMajor('154.0.7610.0')).toBe(154)
    expect(chromeMajor('Mozilla/5.0 (Macintosh) Edg/126.0.2592.87')).toBe(126)
    expect(chromeMajor('Mozilla/5.0 (iPhone) CriOS/120.0.6099.119 Mobile')).toBe(120)
  })

  it('空或无数字返回 null，让上层给出 unknown 而不是假数字', () => {
    expect(chromeMajor('')).toBeNull()
    expect(chromeMajor('unknown')).toBeNull()
    expect(chromeMajor(String(null))).toBeNull()
  })
})

describe('TLS 观测比对', () => {
  it('一切自洽时没有 mismatch', () => {
    const items = compareTls(input())
    const bad = items.filter((i) => i.status === 'mismatch').map((i) => `${i.key} 期望=${i.expected} 实测=${i.actual}`)
    expect(bad).toEqual([])
    expect(byKey(items, 'check.tlsSni')!.status).toBe('ok')
    expect(byKey(items, 'check.tlsKernelCoherence')!.status).toBe('ok')
    expect(byKey(items, 'tls.ja4')!.status).toBe('ok')
    expect(byKey(items, 'h2.fp')!.status).toBe('ok')
  })

  it('SNI 与目标不同 → 说明中间做了 TLS 终结', () => {
    const items = compareTls(input({ tls: view({ sni: 'www.gstatic.com' }) }))
    expect(byKey(items, 'check.tlsSni')!.status).toBe('mismatch')
    expect(byKey(items, 'check.tlsSni')!.actual).toBe('www.gstatic.com')
  })

  it('目标是 IP / 单标签名时 SNI 不适用，不该误报', () => {
    const items = compareTls(input({ host: '127.0.0.1', sniNotApplicable: true, tls: view({ sni: null }) }))
    expect(byKey(items, 'check.tlsSni')!.status).toBe('unknown')
    expect(byKey(items, 'check.tlsSni')!.expected).toBe('不适用')
  })

  it('UA 声明版本与内核实测版本不一致 → 标红（TLS 形状出卖内核）', () => {
    const items = compareTls(input({ declaredMajor: 120, kernelVersion: '154.0.7610.0' }))
    expect(byKey(items, 'check.tlsKernelCoherence')!.status).toBe('mismatch')
    expect(byKey(items, 'check.tlsKernelCoherence')!.expected).toBe('120')
    expect(byKey(items, 'check.tlsKernelCoherence')!.actual).toBe('154')
  })

  it('没有 GREASE 是硬伤：自己拼 ClientHello 的工具最常漏', () => {
    const items = compareTls(input({ tls: view({ greaseCount: 0 }) }))
    expect(byKey(items, 'check.tlsGrease')!.status).toBe('mismatch')
  })

  it('本机观测的 JA4 与服务端看到的不同 → 链路上有 TLS 终结', () => {
    const items = compareTls(
      input({ echo: { ja4: 't13d1310h1_deadbeefcafe_111122223333', h2fp: null, httpVersion: 'http/1.1' } })
    )
    expect(byKey(items, 'check.tlsNoTermination')!.status).toBe('mismatch')
    expect(byKey(items, 'check.httpNegotiated')!.status).toBe('mismatch')
  })

  it('还没有基线时相关项是 unknown，不参与打分', () => {
    const items = compareTls(input({ baseline: null }))
    expect(byKey(items, 'tls.ja4')!.status).toBe('unknown')
    expect(byKey(items, 'tls.ja4')!.note).toContain('先跑一次')
    expect(byKey(items, 'h2.fp')!.status).toBe('unknown')
  })

  it('tap 模式拿不到 H2 → unknown 而不是 mismatch', () => {
    const items = compareTls(input({ h2: null }))
    expect(byKey(items, 'h2.fp')!.status).toBe('unknown')
    expect(byKey(items, 'h2.fp')!.actual).toBe('未观测')
  })

  it('原始 JA3 只用于对账：Chrome 每次连接都不同，不参与判定', () => {
    const items = compareTls(input({ tls: view({ ja3: 'f'.repeat(32) }) }))
    expect(byKey(items, 'tls.ja3Raw')!.status).toBe('unknown')
    // 去 GREASE 且排序后的 JA3 仍然一致
    expect(byKey(items, 'tls.ja3')!.status).toBe('ok')
  })
})