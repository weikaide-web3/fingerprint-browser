import { describe, it, expect } from 'vitest'
import {
  parseClientHello,
  fingerprintHello,
  helloNeedsMoreBytes,
  isGrease,
  versionLabel,
  alpnMarker,
  HelloParseError
} from '../../src/main/tls/hello'
import {
  buildHello,
  sniExt,
  alpnExt,
  groupsExt,
  pointFormatsExt,
  supportedVersionsExt,
  u16List,
  chromeLikeHello,
  GREASE_CIPHER,
  GREASE_GROUP,
  CHROME_CIPHERS,
  specExampleHello,
  SPEC_JA4,
  SPEC_JA4R
} from './tls-fixtures'

/**
 * ClientHello 解析与 JA3 / JA4 计算单测。
 *
 * 用手工构造的字节而不是抓真实流量：真实流量会随内核版本变化，
 * 断言就变成「今天过、明天挂」。真实内核的观测在 tls-live 集成测试里单独验。
 */

describe('ClientHello 解析', () => {
  it('解析出版本、SNI、ALPN、套件与扩展', () => {
    const h = parseClientHello(chromeLikeHello())
    // legacy 字段恒为 0x0303（Chrome 为了兼容把握手版本写死），
    // 真实支持的最高版本来自 supported_versions
    expect(h.legacyVersion).toBe(0x0303)
    expect(h.supportedVersions).toEqual([0x0304, 0x0303, 0x0302])
    expect(h.version).toBe(0x0304)
    expect(h.sni).toBe('example.com')
    expect(h.alpn).toEqual(['h2', 'http/1.1'])
    expect(h.cipherSuites.length).toBe(CHROME_CIPHERS.length + 1)
    expect(h.extensions.length).toBe(11)
    expect(h.supportedGroups).toEqual([GREASE_GROUP, 0x001d, 0x0017, 0x0018])
    expect(h.compressionMethods).toEqual([0])
  })

  it('supported_versions 用 1 字节长度前缀，不能被当成 2 字节读', () => {
    // 回归：曾经用 2 字节长度读它，把 0x0603 当长度、0x0403 当版本号，
    // 结果 JA4 版本段变成 '00'，JA3 的版本字段也变成无意义的 1027。
    const h = parseClientHello(chromeLikeHello())
    expect(h.supportedVersions.every((v) => v === 0x0304 || v === 0x0303 || v === 0x0302)).toBe(true)
    expect(versionLabel(h.version)).toBe('13')
    const noSup = buildHello({
      ciphers: [0x1301],
      extensions: [sniExt('x.example'), { type: 10, body: u16List([0x001d]) }]
    })
    const h2 = parseClientHello(noSup)
    expect(h2.supportedVersions).toEqual([])
    expect(h2.version).toBe(0x0303)
  })

  it('非握手记录与截断字节都抛明确错误', () => {
    expect(() => parseClientHello(Buffer.from([0x17, 0, 0, 0, 0]))).toThrow(HelloParseError)
    expect(() => parseClientHello(Buffer.from([0x16]))).toThrow(/不足以构成 TLS 记录头/)
    const cut = chromeLikeHello().subarray(0, 20)
    expect(helloNeedsMoreBytes(cut)).toBe(true)
    expect(() => parseClientHello(cut)).toThrow(/截断/)
  })

  it('helloNeedsMoreBytes 对完整包返回 false', () => {
    expect(helloNeedsMoreBytes(chromeLikeHello())).toBe(false)
  })

  it('GREASE 判定符合 RFC 8701 形式（0x?a?a）', () => {
    for (const v of [0x0a0a, 0x1a1a, 0x2a2a, 0xfafa]) expect(isGrease(v)).toBe(true)
    for (const v of [0x1301, 0x001d, 0x1a1b]) expect(isGrease(v)).toBe(false)
  })
})

describe('JA3 / JA4 指纹', () => {
  it('JA3 对扩展顺序敏感，JA4 不敏感（这正是两者并存的原因）', () => {
    const a = fingerprintHello(parseClientHello(chromeLikeHello()))
    const shuffled = buildHello({
      ciphers: [GREASE_CIPHER, ...CHROME_CIPHERS],
      extensions: [
        alpnExt(['h2', 'http/1.1']),
        sniExt('example.com'),
        { type: 23, body: Buffer.alloc(0) },
        groupsExt([GREASE_GROUP, 0x001d, 0x0017, 0x0018]),
        pointFormatsExt([0]),
        { type: 13, body: u16List([0x0403, 0x0804, 0x0401]) },
        { type: 51, body: Buffer.concat([Buffer.from([0, 4]), Buffer.alloc(4)]) },
        { type: 45, body: u16List([]) },
        { type: 47, body: u16List([0x0017, 0x001d]) },
        { type: 0xff, body: Buffer.alloc(0) },
        supportedVersionsExt([0x0304, 0x0303, 0x0302])
      ]
    })
    const b = fingerprintHello(parseClientHello(shuffled))
    expect(a.ja3).not.toBe(b.ja3)
    expect(a.ja4).toBe(b.ja4)
  })

  it('JA3 的第一段是 legacy 版本（Chrome 恒为 771），不是 supported_versions', () => {
    const fp = fingerprintHello(parseClientHello(chromeLikeHello()))
    expect(fp.ja3String.startsWith('771,')).toBe(true)
  })

  it('JA4 第一段编码版本 / SNI / 数量 / ALPN', () => {
    const fp = fingerprintHello(parseClientHello(chromeLikeHello()))
    // t + 版本(最高 0x0304 -> '13') + d(有 SNI，指向域名) + 套件数(十进制) + 扩展数(十进制，含 SNI/ALPN) + ALPN
    const prefix = fp.ja4.split('_')[0]
    expect(prefix.startsWith('t13d')).toBe(true)
    expect(prefix.endsWith('h2')).toBe(true)
    expect(fp.ja4r.split('_')[0]).toBe(prefix)
    expect(fp.greaseCount).toBe(2) // 一个密码套件 + 一条曲线
  })

  it('换目标站点不改变 JA4 哈希部分（SNI / ALPN 被刻意排除）', () => {
    const a = fingerprintHello(parseClientHello(chromeLikeHello('a.example')))
    const b = fingerprintHello(parseClientHello(chromeLikeHello('b.example')))
    expect(a.ja4.split('_').slice(1)).toEqual(b.ja4.split('_').slice(1))
    expect(a.sni).toBe('a.example')
    expect(b.sni).toBe('b.example')
  })

  it('无 SNI / 无 ALPN 时标记退化为 i / 00', () => {
    const bare = buildHello({
      ciphers: [0x1301],
      extensions: [{ type: 10, body: u16List([0x001d]) }]
    })
    const fp = fingerprintHello(parseClientHello(bare))
    const prefix = fp.ja4.split('_')[0]
    // t12 + i(无 SNI，直连 IP) + 01 套件 + 01 扩展 + 00 无 ALPN
    expect(prefix).toBe('t12i010100')
    expect(alpnMarker([])).toBe('00')
    expect(alpnMarker(['http/1.1'])).toBe('h1')
    expect(alpnMarker(['h3'])).toBe('h3')
  })

  it('versionLabel 覆盖常见版本', () => {
    expect(versionLabel(0x0304)).toBe('13')
    expect(versionLabel(0x0303)).toBe('12')
    expect(versionLabel(0x0002)).toBe('s2')
    expect(versionLabel(0x9999)).toBe('00')
  })

  it('官方 JA4 文档示例：已知答案必须完全一致', () => {
    // 输入与期望都来自 FoxIO-LLC/ja4 文档，不依赖抓包环境。
    // 任何一处偏差（GREASE / SNI 位 / 计数进制 / 分隔符 / 签名算法是否追加 / 排序）都会红。
    const fp = fingerprintHello(parseClientHello(specExampleHello()))
    expect(fp.ja4).toBe(SPEC_JA4)
    expect(fp.ja4r).toBe(SPEC_JA4R)
  })

  it('空列表写 12 个 0，而不是对空串做哈希', () => {
    const noSig = buildHello({
      ciphers: [],
      extensions: [sniExt('example.com'), alpnExt(['h2'])]
    })
    const fp = fingerprintHello(parseClientHello(noSig))
    const [, ciphersHash, extHash] = fp.ja4.split('_')
    expect(ciphersHash).toBe('000000000000')
    expect(extHash).toBe('000000000000')
    // 00 个密码套件 + 02 个扩展（SNI 与 ALPN 计入总数，只是不参与哈希）
    expect(fp.ja4.split('_')[0]).toBe('t12d0002h2')
  })

  it('Chrome 打乱扩展顺序时：ja3Stable 会变，ja3Sorted 不变', () => {
    // 这是「为什么基线必须用 ja3Sorted」的直接证据：
    // 只去 GREASE 不够，因为 Chrome 110+ 还会随机打乱扩展顺序。
    const a = fingerprintHello(parseClientHello(chromeLikeHello()))
    const shuffled = buildHello({
      ciphers: [GREASE_CIPHER, ...CHROME_CIPHERS],
      extensions: [
        supportedVersionsExt([0x0304, 0x0303, 0x0302]),
        { type: 47, body: u16List([0x0017, 0x001d]) },
        alpnExt(['h2', 'http/1.1']),
        sniExt('example.com'),
        { type: 23, body: Buffer.alloc(0) },
        groupsExt([GREASE_GROUP, 0x001d, 0x0017, 0x0018]),
        pointFormatsExt([0]),
        { type: 13, body: u16List([0x0403, 0x0804, 0x0401]) },
        { type: 51, body: Buffer.concat([Buffer.from([0, 4]), Buffer.alloc(4)]) },
        { type: 45, body: u16List([]) },
        { type: 0xff, body: Buffer.alloc(0) }
      ]
    })
    const b = fingerprintHello(parseClientHello(shuffled))
    expect(a.extOrder).not.toBe(b.extOrder)
    expect(a.ja3Stable).not.toBe(b.ja3Stable)
    expect(a.ja3Sorted).toBe(b.ja3Sorted)
    expect(a.ja4).toBe(b.ja4)
  })

  it('extOrder 保留线上顺序且不含 GREASE', () => {
    const hello = parseClientHello(chromeLikeHello())
    const fp = fingerprintHello(hello)
    const parts = fp.extOrder.split(',').map(Number)
    expect(parts.some((v) => isGrease(v))).toBe(false)
    // 与原始扩展顺序一致（仅去掉 GREASE，不排序）
    const raw = hello.extensions.map((e) => e.type).filter((t) => !isGrease(t))
    expect(parts).toEqual(raw)
  })
})