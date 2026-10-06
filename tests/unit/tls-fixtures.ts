/**
 * TLS 单测的字节构造工具。
 *
 * 手工构造 ClientHello 而不是抓真实流量：真实流量会随内核版本变化，
 * 断言就变成「今天过、明天挂」。真实内核的观测在 tls-live 集成测试里单独验。
 */

export function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n >>> 0)
  return b
}

export function u16List(values: number[]): Buffer {
  return Buffer.concat([u16(values.length * 2), ...values.map(u16)])
}

function ext(type: number, body: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(body.length), body])
}

export interface HelloExt {
  type: number
  body: Buffer
}

/** 组装一条完整的 TLS 记录（含握手头），可直接喂给 parseClientHello */
export function buildHello(opts: { ciphers: number[]; extensions: HelloExt[] }): Buffer {
  const parts: Buffer[] = []
  parts.push(u16(0x0303)) // legacy version
  parts.push(Buffer.alloc(32, 7)) // random
  parts.push(Buffer.from([0])) // 空 session id
  parts.push(u16(opts.ciphers.length * 2))
  parts.push(Buffer.concat(opts.ciphers.map(u16)))
  parts.push(Buffer.from([1, 0])) // compression: null
  const extBuf = Buffer.concat(opts.extensions.map((e) => ext(e.type, e.body)))
  parts.push(u16(extBuf.length))
  parts.push(extBuf)
  const body = Buffer.concat(parts)
  const hsLen = body.length
  const handshake = Buffer.concat([
    Buffer.from([1, (hsLen >> 16) & 0xff, (hsLen >> 8) & 0xff, hsLen & 0xff]),
    body
  ])
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake])
}

export function sniExt(host: string): HelloExt {
  const name = Buffer.from(host, 'ascii')
  const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name])
  return { type: 0, body: Buffer.concat([u16(entry.length), entry]) }
}

export function alpnExt(protos: string[]): HelloExt {
  const items = protos.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'ascii')]))
  const list = Buffer.concat(items)
  return { type: 16, body: Buffer.concat([u16(list.length), list]) }
}

export function groupsExt(groups: number[]): HelloExt {
  return { type: 10, body: u16List(groups) }
}

export function pointFormatsExt(formats: number[]): HelloExt {
  return { type: 11, body: Buffer.concat([Buffer.from([formats.length]), ...formats.map((f) => Buffer.from([f]))]) }
}

/** supported_versions 的长度前缀是 1 字节（与 supported_groups 不同），构造时必须照做 */
export function supportedVersionsExt(versions: number[]): HelloExt {
  return { type: 43, body: Buffer.concat([Buffer.from([versions.length * 2]), ...versions.map(u16)]) }
}

/** GREASE 值：真实 Chrome 会在套件 / 扩展 / 曲线里随机插入 */
export const GREASE_CIPHER = 0x1a1a
export const GREASE_GROUP = 0x3a3a

export const CHROME_CIPHERS = [0x1301, 0x1303, 0x1302, 0xc02f, 0xc02b, 0xcca8, 0xcca9, 0xc030, 0xc02c, 0xccaa]

/** 贴近 Chrome 的 ClientHello：含 GREASE、SNI、ALPN=h2、11 个扩展 */
export function chromeLikeHello(host = 'example.com'): Buffer {
  return buildHello({
    ciphers: [GREASE_CIPHER, ...CHROME_CIPHERS],
    extensions: [
      { type: 0xff, body: Buffer.alloc(0) },
      sniExt(host),
      { type: 23, body: Buffer.alloc(0) },
      groupsExt([GREASE_GROUP, 0x001d, 0x0017, 0x0018]),
      pointFormatsExt([0]),
      { type: 13, body: u16List([0x0403, 0x0804, 0x0401]) },
      { type: 51, body: Buffer.concat([Buffer.from([0, 4]), Buffer.alloc(4)]) },
      { type: 45, body: u16List([]) },
      alpnExt(['h2', 'http/1.1']),
      { type: 47, body: u16List([0x0017, 0x001d]) },
      supportedVersionsExt([0x0304, 0x0303, 0x0302])
    ]
  })
}

/**
 * 官方 JA4 文档（FoxIO-LLC/ja4）里给出的示例 ClientHello。
 *
 * 这是**已知答案测试**：文档同时给出输入列表与期望输出
 * `t13d1516h2_8daaf6152771_e5627efa2ab1`，以及 JA4_r 原文。
 * 只要我们的实现与规范有任何一处偏差（GREASE、SNI 位、计数进制、分隔符、
 * 签名算法是否追加、排序规则），这条断言就会红 —— 不必依赖抓包环境。
 */
export const SPEC_CIPHERS = [
  0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035
]
export const SPEC_SIGALGS = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601]
export const SPEC_JA4 = 't13d1516h2_8daaf6152771_e5627efa2ab1'
export const SPEC_JA4R =
  't13d1516h2_002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9' +
  '_0005,000a,000b,000d,0012,0015,0017,001b,0023,002b,002d,0033,4469,ff01' +
  '_0403,0804,0401,0503,0805,0501,0806,0601'

export function specExampleHello(): Buffer {
  // 线上顺序照文档的 JA4_ro：001b,0000,0033,0010,4469,0017,002d,000d,0005,0023,0012,002b,ff01,000b,000a,0015
  return buildHello({
    ciphers: SPEC_CIPHERS,
    extensions: [
      { type: 0x1b, body: u16List([0x0017, 0x001d]) },
      sniExt('example.com'),
      { type: 0x33, body: Buffer.alloc(0) },
      alpnExt(['h2', 'http/1.1']),
      { type: 0x4469, body: Buffer.alloc(0) },
      { type: 0x17, body: Buffer.alloc(0) },
      { type: 0x2d, body: u16List([]) },
      { type: 0x0d, body: u16List([0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601]) },
      { type: 0x05, body: Buffer.from([0, 5, 0, 0, 0]) },
      { type: 0x23, body: Buffer.alloc(0) },
      { type: 0x12, body: Buffer.from([3, 8, ...'http/1.1'.split('').map((c) => c.charCodeAt(0))]) },
      supportedVersionsExt([0x0304, 0x0303, 0x0302]),
      // 文档里这一项是 0xff01（65281），不是 0xff —— 写错一位哈希就对不上
      { type: 0xff01, body: Buffer.alloc(0) },
      pointFormatsExt([0, 1, 2]),
      groupsExt([0x001d, 0x0017, 0x0018, 0x0019]),
      { type: 0x15, body: Buffer.alloc(0) }
    ]
  })
}