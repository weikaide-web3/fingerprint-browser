import { createHash } from 'node:crypto'

/**
 * TLS ClientHello 解析与指纹计算（纯函数，不依赖网络，便于单测）。
 *
 * 为什么需要它：Google / X(Cloudflare) 在服务端记录 TLS 握手指纹，
 * 并与 UA 声明的浏览器版本比对。UA 说 Chrome 153 但 ClientHello 是
 * Node / 老 Chromium 的形状，就是最省事的机器人判定依据之一。
 * 我们没法从 JS 层改 ClientHello，所以第一步必须先「看得见」它。
 */

const CT_HANDSHAKE = 0x16
const HS_CLIENT_HELLO = 0x01

export interface TlsExtension {
  type: number
  data: Buffer
}

export interface ClientHello {
  /** 记录层版本（TLS1.3 客户端通常仍写 0x0303） */
  recordVersion: number
  /** 握手体里的 legacy_version */
  legacyVersion: number
  /** supported_versions(43) 里声明的最高版本，例如 0x0304 = TLS 1.3 */
  supportedVersions: number[]
  /** 实际使用的版本：supported_versions 里的最高值优先于 legacy_version */
  version: number
  random: Buffer
  sessionId: Buffer
  cipherSuites: number[]
  compressionMethods: number[]
  extensions: TlsExtension[]
  sni: string | null
  alpn: string[]
  supportedGroups: number[]
  ecPointFormats: number[]
  signatureAlgorithms: number[]
  /** 完整记录（含记录层头） */
  raw: Buffer
}

export interface TlsFingerprint {
  ja3String: string
  ja3: string
  /**
   * 去掉 GREASE 后的 JA3。
   *
   * Chrome 每次连接都会随机挑一个 GREASE 值（0x?A?A）插进套件/扩展/曲线，
   * 于是**同一台机器同一个内核的原始 JA3 每次都不同**。这是 JA3 在 Chrome 上
   * 失效的根本原因，也是 JA4 存在的原因。
   * 我们仍然保留原始 JA3（有些检测方就在用它，且「GREASE 缺失」本身是特征），
   * 但基线比对必须用这个去 GREASE 的版本，否则每次都会误报成「换了内核」。
   */
  ja3StableString: string
  ja3Stable: string
  /**
   * 去 GREASE **并且把套件/扩展/曲线排序**后的 JA3。
   *
   * 这是跨连接唯一可靠的 JA3 形态。原因不是 GREASE，而是 Chrome 110+
   * 会**随机打乱扩展顺序**（实测同一内核每次连接的扩展顺序都不同），
   * 而 JA3 按线上顺序哈希扩展 —— 所以 Chrome 的 JA3 从设计上就不可能稳定，
   * 这也是 JA3 官方退役、业界转向 JA4 的直接原因。
   * 基线比对一律用这一项（或 JA4），用原始/去 GREASE 的 JA3 必然每次误报。
   */
  ja3SortedString: string
  ja3Sorted: string
  /** 去掉 GREASE 后的扩展线上顺序；两次观测不同 = 该客户端在打乱扩展顺序（真 Chrome 会） */
  extOrder: string
  ja4r: string
  ja4: string
  versionLabel: string
  sni: string | null
  alpn: string[]
  cipherCount: number
  extensionCount: number
  greaseCount: number
}

/** 解析失败时抛这个；调用方按「无法观测」处理，不当成安全事件 */
export class HelloParseError extends Error {}

function need(buf: Buffer, at: number, n: number, what: string): void {
  if (at + n > buf.length) throw new HelloParseError(`ClientHello 截断：读取 ${what} 需要 ${n} 字节`)
}

/** 0x0304 -> '13' 这类 JA4 版本标记（映射照官方规范，别自己编） */
export function versionLabel(code: number): string {
  switch (code) {
    case 0x0304:
      return '13'
    case 0x0303:
      return '12'
    case 0x0302:
      return '11'
    case 0x0301:
      return '10'
    case 0x0300:
      return 's3'
    case 0x0002:
      return 's2'
    case 0xfeff:
      return 'd1'
    case 0xfefd:
      return 'd2'
    case 0xfefc:
      return 'd3'
    default:
      return '00'
  }
}

function readU16List(b: Buffer | null): number[] {
  if (!b || b.length < 2) return []
  const len = ((b[0] << 8) | b[1]) >>> 0
  const out: number[] = []
  for (let i = 0; i + 1 < len && 2 + i + 1 < b.length; i += 2) out.push(((b[2 + i] << 8) | b[3 + i]) >>> 0)
  return out
}

/**
 * 1 字节长度前缀的列表（supported_versions 用的是 1 字节，不是 2 字节）。
 *
 * 这里踩过坑：用 readU16List 读 supported_versions，会把
 * [06 03 04 03 03 03 02] 里的 0x0603 当成长度、再读出 0x0403 当版本号，
 * 于是 JA4 版本段变成 '00'、JA3 的版本字段也变成无意义的 1027。
 */
function readU8List(b: Buffer | null): number[] {
  if (!b || b.length < 1) return []
  const len = b[0] >>> 0
  const out: number[] = []
  for (let i = 0; i + 1 < len && 1 + i + 1 <= b.length; i += 2) out.push(((b[1 + i] << 8) | b[2 + i]) >>> 0)
  return out
}

/** 从 TCP 流的一段字节解析 ClientHello */
export function parseClientHello(buf: Buffer): ClientHello {
  if (buf.length < 5) throw new HelloParseError('字节数不足以构成 TLS 记录头')
  if (buf[0] !== CT_HANDSHAKE) throw new HelloParseError(`不是握手记录（contentType=0x${buf[0].toString(16)}）`)
  const recordVersion = ((buf[1] << 8) | buf[2]) >>> 0
  const recordLen = ((buf[3] << 8) | buf[4]) >>> 0
  need(buf, 5, 4, '握手头')
  if (buf[5] !== HS_CLIENT_HELLO) throw new HelloParseError(`不是 ClientHello（type=0x${buf[5].toString(16)}）`)
  const hsLen = (buf[6] << 16) | (buf[7] << 8) | buf[8]
  const bodyStart = 9
  need(buf, bodyStart, hsLen, 'ClientHello 体')

  let p = bodyStart
  const legacyVersion = ((buf[p] << 8) | buf[p + 1]) >>> 0
  p += 2
  const random = buf.subarray(p, p + 32)
  p += 32
  const sidLen = buf[p]
  need(buf, p, 1 + sidLen, 'sessionId')
  const sessionId = buf.subarray(p + 1, p + 1 + sidLen)
  p += 1 + sidLen

  const csLen = ((buf[p] << 8) | buf[p + 1]) >>> 0
  need(buf, p, 2 + csLen, 'cipherSuites')
  const cipherSuites: number[] = []
  for (let i = 0; i + 1 < csLen; i += 2) cipherSuites.push(((buf[p + 2 + i] << 8) | buf[p + 3 + i]) >>> 0)
  p += 2 + csLen

  const cmLen = buf[p]
  need(buf, p, 1 + cmLen, 'compression')
  const compressionMethods: number[] = []
  for (let i = 0; i < cmLen; i++) compressionMethods.push(buf[p + 1 + i])
  p += 1 + cmLen

  const extLen = ((buf[p] << 8) | buf[p + 1]) >>> 0
  need(buf, p, 2 + extLen, 'extensions')
  p += 2
  const extEnd = p + extLen
  const extensions: TlsExtension[] = []
  while (p + 4 <= extEnd) {
    const type = ((buf[p] << 8) | buf[p + 1]) >>> 0
    const len = ((buf[p + 2] << 8) | buf[p + 3]) >>> 0
    if (p + 4 + len > extEnd) throw new HelloParseError('扩展长度越界')
    extensions.push({ type, data: buf.subarray(p + 4, p + 4 + len) })
    p += 4 + len
  }

  const find = (type: number): Buffer | null => {
    const e = extensions.find((x) => x.type === type)
    return e ? e.data : null
  }

  let sni: string | null = null
  const sniBuf = find(0)
  if (sniBuf && sniBuf.length >= 5) {
    const listLen = ((sniBuf[0] << 8) | sniBuf[1]) >>> 0
    if (listLen + 2 <= sniBuf.length) {
      const nameLen = ((sniBuf[3] << 8) | sniBuf[4]) >>> 0
      if (5 + nameLen <= sniBuf.length) sni = sniBuf.subarray(5, 5 + nameLen).toString('ascii')
    }
  }

  const alpn: string[] = []
  const alpnBuf = find(16)
  if (alpnBuf && alpnBuf.length >= 2) {
    const listLen = ((alpnBuf[0] << 8) | alpnBuf[1]) >>> 0
    let q = 2
    while (q < 2 + listLen && q < alpnBuf.length) {
      const l = alpnBuf[q]
      if (q + 1 + l > alpnBuf.length) break
      alpn.push(alpnBuf.subarray(q + 1, q + 1 + l).toString('ascii'))
      q += 1 + l
    }
  }

  const supportedVersions = readU8List(find(43))
  // JA4 取「客户端声明支持的最高版本」，且必须跳过 GREASE：
  // Chrome 会把 GREASE 放在 supported_versions 最前面，它数值最大，
  // 不剔除就会让版本段变成 '00'（实测踩过）。没有该扩展时退回 legacy。
  const realVersions = stripGrease(supportedVersions)
  const highest = realVersions.reduce((a, b) => (b > a ? b : a), 0)
  const version = highest > 0 ? highest : legacyVersion

  const epBuf = find(11)
  const ecPointFormats: number[] = []
  if (epBuf && epBuf.length >= 1) {
    const len = epBuf[0]
    for (let i = 0; i < len && 1 + i < epBuf.length; i++) ecPointFormats.push(epBuf[1 + i])
  }

  return {
    recordVersion,
    legacyVersion,
    supportedVersions,
    version,
    random,
    sessionId,
    cipherSuites,
    compressionMethods,
    extensions,
    sni,
    alpn,
    supportedGroups: readU16List(find(10)),
    ecPointFormats,
    signatureAlgorithms: readU16List(find(13)),
    raw: buf.subarray(0, Math.min(buf.length, 5 + recordLen))
  }
}

/** 首包可能被拆成多个 chunk：判断是否还没收全 */
export function helloNeedsMoreBytes(buf: Buffer): boolean {
  if (buf.length < 5) return true
  if (buf[0] !== CT_HANDSHAKE) return false
  const recordLen = ((buf[3] << 8) | buf[4]) >>> 0
  return buf.length < 5 + recordLen
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12)
}

/**
 * 规范规定：某个列表为空时，对应字段直接写死 12 个 0，
 * 而不是对空串做哈希 —— 这样一眼能看出「这一项没有值」。
 */
const EMPTY_LIST = '000000000000'

/** 计数是十进制两字符（规范例子里 15 个套件写 '15'，不是十六进制），超过 99 按 99 */
function count2(n: number): string {
  return Math.min(99, Math.max(0, n)).toString().padStart(2, '0')
}

function hex4(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, '0')
}

/** GREASE 值在任何位置都要忽略（规范明确要求） */
export function stripGrease(values: number[]): number[] {
  return values.filter((v) => !isGrease(v))
}

/**
 * GREASE（Generate Extensions And Cryptography Extension Attempt）。
 * 真实 Chrome 会在密码套件 / 扩展 / 曲线里随机插入 0x?A?A 形式的占位值，
 * 用来防止中间盒固化行为。16 位形式满足：高字节 === 低字节 且低半字节 === 0xa。
 *
 * 这一项很重要：自己拼 ClientHello 的工具几乎总会忘记 GREASE，
 * 于是「没有 GREASE」本身就是机器人特征。
 */
export function isGrease(value: number): boolean {
  const v = value & 0xffff
  return v >> 8 === (v & 0xff) && (v & 0x0f) === 0x0a
}

export function countGrease(h: ClientHello): number {
  let n = 0
  for (const c of h.cipherSuites) if (isGrease(c)) n += 1
  for (const e of h.extensions) if (isGrease(e.type)) n += 1
  for (const g of h.supportedGroups) if (isGrease(g)) n += 1
  return n
}

/**
 * SNI 标记（规范原文：SNI="d" or no SNI="i"）。
 *
 * 直觉上会把「有 SNI」想成 i(dentify)，实际相反：
 * 有 SNI 说明目标是**域名** -> 'd'；没有 SNI 说明直连 IP -> 'i'。
 * 这一位写反，指纹就和所有主流实现（含 Cloudflare 侧记录）对不上。
 */
export function sniMarker(sni: string | null): string {
  return sni ? 'd' : 'i'
}

/**
 * ALPN 标记：取第一个 ALPN 协议值的首 / 末「字母数字」字符。
 * h2 -> h2，http/1.1 -> h1，h3 -> h3，无 ALPN -> 00。
 */
export function alpnMarker(alpn: string[]): string {
  if (!alpn.length) return '00'
  const alnum = String(alpn[0] ?? '').replace(/[^a-z0-9]/gi, '')
  if (!alnum) return '00'
  if (alnum.length === 1) return (alnum + '0').toLowerCase()
  return (alnum[0] + alnum[alnum.length - 1]).toLowerCase()
}

/**
 * JA3 + JA4（严格按官方规范，逐条对齐已知答案向量）。
 *
 * JA3 用「线上顺序」，扩展顺序变化就会改变结果；
 * JA4 把密码套件与扩展**排序后**再哈希，对顺序抖动更稳。
 * 两者都保留：不同检测方用的不是同一个算法。
 *
 * 之前有 7 处偏差，都会让指纹与业界观测对不上（现已用官方示例做已知答案测试锁死）：
 * 1. GREASE 未剔除 —— 它每次连接都变，留着自己的 JA4 就每帧不同；
 * 2. SNI 标记写反（有 SNI 应是 'd'，无 SNI 是 'i'）；
 * 3. 计数应为十进制（15 -> '15'），不是十六进制；
 * 4. 第一段的扩展数统计**全部**扩展（含 SNI/ALPN），只有哈希才排除 0 与 16；
 * 5. 扩展哈希必须把 signature_algorithms 按**线上顺序**追加在末尾，两段之间用 '_'；
 * 6. 列表内部的分隔符是 ','，不是 '-'；
 * 7. 空列表写 '000000000000'，不做哈希。
 */
export function fingerprintHello(h: ClientHello): TlsFingerprint {
  // JA3 用的是 ClientHello 里的 legacy version 字段（Chrome 恒为 0x0303=771），
  // 不是 supported_versions 的最高版本 —— 用错就会算出完全不同的 JA3。
  const ja3Version = h.legacyVersion & 0xffff
  const ja3String = [
    ja3Version,
    h.cipherSuites.join(','),
    h.extensions.map((e) => e.type).join(','),
    h.supportedGroups.join(','),
    h.ecPointFormats.join(',')
  ].join(',')

  // 去 GREASE 但保留线上顺序：用来判断「这个客户端是否在打乱扩展顺序」
  const extOrderList = stripGrease(h.extensions.map((e) => e.type))

  // 只去 GREASE、不排序：Chrome 的 GREASE 值每次连接都变，去掉之后
  // 若扩展顺序也不变，这一项就与原始 JA3 等价；一旦顺序被打乱，它立刻与排序版不同。
  const ja3StableString = [
    ja3Version,
    stripGrease(h.cipherSuites).join(','),
    extOrderList.join(','),
    stripGrease(h.supportedGroups).join(','),
    h.ecPointFormats.join(',')
  ].join(',')

  // 去 GREASE **并且排序**：Chrome 每次连接都会随机插入 GREASE，
  // 还会随机打乱 TLS 扩展顺序（实测同一内核两次握手的扩展顺序不同），
  // 所以只去 GREASE 不够 —— 排序后的这串才跨连接可比，用于基线判定。
  const ja3SortedString = [
    ja3Version,
    stripGrease(h.cipherSuites).sort((a, b) => a - b).join(','),
    extOrderList.slice().sort((a, b) => a - b).join(','),
    stripGrease(h.supportedGroups).sort((a, b) => a - b).join(','),
    h.ecPointFormats.join(',')
  ].join(',')

  const ciphers = stripGrease(h.cipherSuites).sort((a, b) => a - b)
  // 计数含 SNI / ALPN，只排除 GREASE
  const extAll = extOrderList
  // 哈希排除 SNI(0) 与 ALPN(16)：这两项已在第一段体现，且本就该随目标站点变化
  const extHash = [...extAll].filter((t) => t !== 0 && t !== 16).sort((a, b) => a - b)
  // 签名算法保持线上顺序，不排序
  const sigAlgs = stripGrease(h.signatureAlgorithms)

  const prefix =
    `t${versionLabel(h.version)}${sniMarker(h.sni)}` + count2(ciphers.length) + count2(extAll.length) + alpnMarker(h.alpn)

  const cipherList = ciphers.length ? ciphers.map(hex4).join(',') : EMPTY_LIST
  const extList = extHash.length ? extHash.map(hex4).join(',') : EMPTY_LIST
  const sigList = sigAlgs.map(hex4).join(',')

  // 哈希输入：扩展段与签名段用 '_' 相连；没有签名算法时不带下划线
  const extHashInput = extHash.length ? (sigList ? `${extList}_${sigList}` : extList) : EMPTY_LIST

  const ja4r = [prefix, cipherList, extList, ...(sigList ? [sigList] : [])].join('_')
  // 空列表直接写 12 个 0，不能对 EMPTY_LIST 这个占位串做哈希
  const ja4 = [
    prefix,
    ciphers.length ? shortHash(cipherList) : EMPTY_LIST,
    extHash.length ? shortHash(extHashInput) : EMPTY_LIST
  ].join('_')

  return {
    ja3String,
    ja3: createHash('md5').update(ja3String).digest('hex'),
    ja3StableString,
    ja3Stable: createHash('md5').update(ja3StableString).digest('hex'),
    ja3SortedString,
    ja3Sorted: createHash('md5').update(ja3SortedString).digest('hex'),
    extOrder: extOrderList.join(','),
    ja4r,
    ja4,
    versionLabel: versionLabel(h.version),
    sni: h.sni,
    alpn: h.alpn,
    cipherCount: ciphers.length,
    extensionCount: extAll.length,
    greaseCount: countGrease(h)
  }
}