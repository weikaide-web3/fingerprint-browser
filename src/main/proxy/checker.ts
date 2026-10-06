import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns/promises'

/**
 * 代理可用性 / 出口 IP 探测。
 *
 * 不引入第三方 socks 客户端：直接按 SOCKS4 / SOCKS5 / HTTP CONNECT 的报文格式
 * 手写握手，好处是零依赖、行为可控，并且能在单测里用本地假代理服务器完整验证。
 */

export type ProxyScheme = 'http' | 'https' | 'socks5' | 'socks5h' | 'socks4'

export interface ProxyEndpoint {
  scheme: ProxyScheme
  host: string
  port: number
  username?: string | null
  password?: string | null
}

/** 隧道打通后要访问的目标（默认是免费无鉴权的 ip-api.com） */
export interface ProbeTarget {
  host: string
  port: number
  path: string
  /**
   * 隧道内再套一层 TLS（即 https 探测点）。
   *
   * 默认探测点走明文 http，等于把「你正在用哪个代理 + 你的真实出口 IP」
   * 明文广播给路径上任何人。付费/自建探测点支持 https 时应开启，
   * 而且只有付费版才返回 usageType / anycast / reverse 这些判定必需的字段。
   */
  tls?: boolean
}

export interface ProbeOutcome {
  ok: boolean
  error: string | null
  /** 到代理服务器的 TCP 建连耗时 */
  connectMs: number
  /** 整个探测耗时（建连 + 握手 + 取回出口信息） */
  totalMs: number
  /** 目标返回的原始响应体，失败时为空串 */
  body: string
}

export const DEFAULT_TARGET: ProbeTarget = {
  host: 'ip-api.com',
  port: 80,
  // fields 必须显式列全：ip-api 免费版默认只返回基础字段，
  // 少了 usageType / hosting / proxy / mobile 就没法判定出口质量，
  // 而这项恰恰是 Google、X 场景下最关键的一条。
  path:
    '/json/?fields=status,message,country,regionName,city,isp,timezone,query,' +
    'as,org,reverse,usageType,hosting,proxy,mobile,anycast'
}

/** 按标记切分 socket 数据流：握手阶段是二进制定长 + 文本头，需要两种读取方式 */
export class Reader {
  private buf = Buffer.alloc(0)
  private waiters: (() => void)[] = []
  private detachFn: () => void = () => {}

  constructor(sock: net.Socket) {
    const onData = (chunk: Buffer): void => {
      this.buf = Buffer.concat([this.buf, chunk])
      const pending = this.waiters
      this.waiters = []
      for (const w of pending) w()
    }
    sock.on('data', onData)
    this.detachFn = (): void => {
      sock.removeListener('data', onData)
    }
  }

  /**
   * 停止自行消费数据，把 socket 交还给 pipe()。
   * 不做这一步的话 Reader 的 data 监听和 pipe 会各自收到同一份 chunk，
   * 导致转发内容重复。
   */
  detach(): void {
    this.detachFn()
  }

  private async waitFor(remain: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake)
        resolve()
      }, remain)
      this.waiters.push(wake)
    })
  }

  /** 读到 marker（含）为止；超时抛错 */
  async until(marker: Buffer, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const at = this.buf.indexOf(marker)
      if (at >= 0) {
        const out = this.buf.subarray(0, at + marker.length)
        this.buf = this.buf.subarray(at + marker.length)
        return out
      }
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error('读取代理响应超时')
      await this.waitFor(remain)
    }
  }

  /** 读满 n 字节；超时抛错 */
  async exact(n: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.buf.length >= n) {
        const out = this.buf.subarray(0, n)
        this.buf = this.buf.subarray(n)
        return out
      }
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error(`读取代理响应不足（需要 ${n} 字节，只有 ${this.buf.length}）`)
      await this.waitFor(remain)
    }
  }

  /** 已被读取器缓冲、但还没被消费的字节（relay 转发时需要先冲出去） */
  pending(): Buffer {
    const out = this.buf
    this.buf = Buffer.alloc(0)
    return out
  }

  /** 读到对端关闭（配合 Connection: close），返回期间累积的全部字节 */
  toEnd(sock: net.Socket, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('读取目标响应超时'))
      }, timeoutMs)
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(this.buf)
      }
      sock.once('end', finish)
      sock.once('close', finish)
      sock.once('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`读取目标响应中断 — ${e.message}`))
      })
    })
  }
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<{ sock: net.Socket; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const sock = net.createConnection({ host, port })
    sock.setNoDelay(true)
    const done = (fn: () => void): void => {
      sock.removeAllListeners('connect')
      sock.removeAllListeners('error')
      sock.setTimeout(0)
      fn()
    }
    sock.once('connect', () => done(() => resolve({ sock, ms: Date.now() - started })))
    sock.once('error', (e) => done(() => reject(new Error(`连接代理失败 ${host}:${port} — ${e.message}`))))
    sock.setTimeout(timeoutMs, () => {
      sock.destroy()
      done(() => reject(new Error(`连接代理超时 ${host}:${port}`)))
    })
  })
}

function basicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
}

/** HTTP / HTTPS 代理：先（可选）套 TLS，再发 CONNECT 建立隧道 */
async function httpTunnel(
  sock: net.Socket,
  reader: Reader,
  ep: ProxyEndpoint,
  target: { host: string; port: number },
  timeoutMs: number
): Promise<void> {
  const lines = [`CONNECT ${target.host}:${target.port} HTTP/1.1`, `Host: ${target.host}:${target.port}`]
  if (ep.username) {
    lines.push(`Proxy-Authorization: Basic ${basicAuth(ep.username, ep.password ?? '')}`)
  }
  sock.write(`${lines.join('\r\n')}\r\n\r\n`)

  const head = (await reader.until(Buffer.from('\r\n\r\n'), timeoutMs)).toString('latin1')
  const statusLine = head.split('\r\n', 1)[0]
  const status = Number(statusLine.split(' ')[1] ?? '0')
  if (status !== 200) {
    const reason = status === 407 ? '代理需要认证（账号密码不正确或未提供）' : `代理拒绝 CONNECT（HTTP ${status}）`
    throw new Error(reason)
  }
}

/** SOCKS5，含 RFC 1929 用户名/密码子协商。目标用域名（ATYP=3），交给代理侧解析 */
async function socks5Tunnel(
  sock: net.Socket,
  reader: Reader,
  ep: ProxyEndpoint,
  target: { host: string; port: number },
  timeoutMs: number
): Promise<void> {
  const hasAuth = Boolean(ep.username)
  const methods = hasAuth ? [0x00, 0x02] : [0x00]
  sock.write(Buffer.from([0x05, methods.length, ...methods]))

  const greeting = await reader.exact(2, timeoutMs)
  if (greeting[0] !== 0x05) throw new Error('对端不是 SOCKS5 代理')
  const chosen = greeting[1]
  if (chosen === 0xff) throw new Error('代理不接受任何认证方式')

  if (chosen === 0x02) {
    const user = Buffer.from(ep.username ?? '', 'utf8')
    const pass = Buffer.from(ep.password ?? '', 'utf8')
    if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 账号或密码过长')
    sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const sub = await reader.exact(2, timeoutMs)
    if (sub[0] !== 0x01) throw new Error('SOCKS5 认证子协商响应格式错误')
    if (sub[1] !== 0x00) throw new Error('SOCKS5 认证失败（账号或密码不正确）')
  }

  const domain = Buffer.from(target.host, 'utf8')
  if (domain.length > 255) throw new Error('目标域名过长')
  sock.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
      domain,
      Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff])
    ])
  )

  const reply = await reader.exact(4, timeoutMs)
  if (reply[0] !== 0x05) throw new Error('SOCKS5 响应版本错误')
  if (reply[1] !== 0x00) throw new Error(`SOCKS5 连接失败（rep=${reply[1]}）`)
  // 响应后面还跟着 BND.ADDR / BND.PORT，必须按 ATYP 精确吃掉，
  // 否则残留字节会被当成后续 HTTP 响应的开头。
  const atyp = reply[3]
  if (atyp !== 0x01 && atyp !== 0x03 && atyp !== 0x04) throw new Error(`SOCKS5 未知地址类型 ${atyp}`)
  const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (await reader.exact(1, timeoutMs))[0]
  await reader.exact(addrLen + 2, timeoutMs)
}

/** SOCKS4：协议只认 IPv4，所以本地先解析一次 DNS */
async function socks4Tunnel(
  sock: net.Socket,
  reader: Reader,
  ep: ProxyEndpoint,
  target: { host: string; port: number },
  timeoutMs: number
): Promise<void> {
  const { address } = await dns.lookup(target.host)
  if (!net.isIPv4(address)) throw new Error(`SOCKS4 只支持 IPv4 目标，解析结果为 ${address}`)
  const ip = address.split('.').map((n) => Number(n))
  const user = Buffer.from(ep.username ?? '', 'utf8')
  sock.write(
    Buffer.concat([
      Buffer.from([0x04, 0x01, (target.port >> 8) & 0xff, target.port & 0xff, ip[0], ip[1], ip[2], ip[3]]),
      user,
      Buffer.from([0x00])
    ])
  )
  const reply = await reader.exact(8, timeoutMs)
  if (reply[0] !== 0x00) throw new Error('对端不是 SOCKS4 代理')
  const cd = reply[1]
  if (cd === 90) return
  if (cd === 91 || cd === 92) throw new Error('SOCKS4 认证被拒（需要 identd，本应用不支持）')
  throw new Error(`SOCKS4 连接失败（cd=${cd}）`)
}

/**
 * HTTPS 代理：CONNECT 之前先把 TCP 连接升级成 TLS。
 * rejectUnauthorized 关闭：代理服务商大量使用自签证书，严格校验会让绝大多数
 * 节点直接判为不可用。这里传输的机密只有代理账号，不涉及业务凭据。
 */
function tlsUpgrade(sock: net.Socket, servername: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const plain = sock as tls.TLSSocket
    const t = tls.connect({
      socket: plain,
      servername,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false
    })
    t.once('secureConnect', () => resolve(t))
    t.once('error', (e) => reject(new Error(`代理 TLS 握手失败 — ${e.message}`)))
  })
}

/** 解 Transfer-Encoding: chunked。按 Buffer 处理，避免多字节 UTF-8 跨块被切坏 */
function decodeChunked(raw: Buffer): string {
  const parts: Buffer[] = []
  let i = 0
  for (;;) {
    const nl = raw.indexOf('\r\n', i)
    if (nl < 0) throw new Error('分块响应格式错误（缺少长度行）')
    const size = parseInt(raw.subarray(i, nl).toString('latin1').split(';')[0], 16)
    if (Number.isNaN(size)) throw new Error(`分块响应长度行无法解析：${raw.subarray(i, nl).toString('latin1')}`)
    if (size === 0) break
    if (nl + 2 + size > raw.length) throw new Error('分块响应被截断')
    parts.push(raw.subarray(nl + 2, nl + 2 + size))
    i = nl + 2 + size + 2 // 跳过块尾的 \r\n
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 拆出 HTTP 响应状态与 body；非 2xx 抛错。支持 chunked 与定长两种 body */
function parseHttpResponse(raw: Buffer): string {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep < 0) throw new Error('目标返回的不是完整 HTTP 响应')
  const head = raw.subarray(0, sep).toString('latin1')
  const statusLine = head.split('\r\n')[0]
  const status = Number(statusLine.split(' ')[1] ?? '0')
  if (!status || status >= 400) throw new Error(`目标返回 HTTP ${status}`)
  const body = raw.subarray(sep + 4)
  if (/transfer-encoding:\s*chunked/i.test(head)) return decodeChunked(body)
  return body.toString('utf8')
}

export interface Tunnel {
  sock: net.Socket
  reader: Reader
  /** 到代理服务器的 TCP 建连耗时 */
  connectMs: number
}

/**
 * 打通「本机 → 代理 → 目标」的隧道，返回可直接读写的 socket。
 * 探测和 relay 共用这一条路径，保证「检测通过的代理」和「浏览器实际走的代理」
 * 是同一段代码，不会出现检测说通、浏览器却不通的情况。
 */
export async function openTunnel(
  ep: ProxyEndpoint,
  target: { host: string; port: number },
  timeoutMs = 10000
): Promise<Tunnel> {
  const conn = await tcpConnect(ep.host, ep.port, timeoutMs)
  try {
    let sock = conn.sock
    if (ep.scheme === 'https') sock = await tlsUpgrade(sock, ep.host)
    const reader = new Reader(sock)
    if (ep.scheme === 'socks5' || ep.scheme === 'socks5h') await socks5Tunnel(sock, reader, ep, target, timeoutMs)
    else if (ep.scheme === 'socks4') await socks4Tunnel(sock, reader, ep, target, timeoutMs)
    else await httpTunnel(sock, reader, ep, target, timeoutMs)
    return { sock, reader, connectMs: conn.ms }
  } catch (e) {
    conn.sock.destroy()
    throw e
  }
}

/**
 * 探测一个代理：打通隧道后在隧道内取回出口信息。
 * 任何一步失败都不抛错，而是把原因放进返回值的 error 字段，
 * 因为调用方（UI / 批量检测）需要把失败当作正常结果展示并落库。
 */
export async function probeProxy(
  ep: ProxyEndpoint,
  target: ProbeTarget = DEFAULT_TARGET,
  timeoutMs = 10000
): Promise<ProbeOutcome> {
  const started = Date.now()
  let tunnel: Tunnel | null = null
  try {
    tunnel = await openTunnel(ep, target, timeoutMs)
    // https 探测点：在已打通的隧道里再套一层 TLS。
    // 明文 http 探测会把「用了哪个代理 + 真实出口 IP」广播给路径上任何人。
    let sock: net.Socket = tunnel.sock
    if (target.tls) sock = await tlsUpgrade(tunnel.sock, target.host)
    const reader = sock === tunnel.sock ? tunnel.reader : new Reader(sock)
    const hostHeader = target.port === 443 ? target.host : `${target.host}:${target.port}`
    sock.write(
      `GET ${target.path} HTTP/1.1\r\nHost: ${hostHeader}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`
    )
    const body = parseHttpResponse(await reader.toEnd(sock, timeoutMs))
    return { ok: true, error: null, connectMs: tunnel.connectMs, totalMs: Date.now() - started, body }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      connectMs: tunnel?.connectMs ?? 0,
      totalMs: Date.now() - started,
      body: ''
    }
  } finally {
    tunnel?.sock.destroy()
  }
}

export interface ExitInfo {
  ip: string | null
  country: string | null
  region: string | null
  city: string | null
  isp: string | null
  timezone: string | null
  /** 自治系统编号，例如 "AS61726" */
  asn: string | null
  /** 自治系统 / 组织名，例如 "Peer1 US LLC" */
  asName: string | null
  org: string | null
  reverse: string | null
  /** ip-api 的 usageType：COM / MOBILE / CORPORATE / EDUCATION / GOVERNMENT / ISP / SEARCH / RESERVED */
  usageType: string | null
  /** 机房 / 云 / VPS 出口 */
  hosting: boolean
  /** 匿名代理 / VPN 出口 */
  isProxy: boolean
  /** 蜂窝网络出口 */
  mobile: boolean
  anycast: boolean
  /**
   * 探测点**没有返回**的质量信号字段名。
   *
   * 为什么必须单独记：hosting / proxy / mobile / anycast 是布尔量，
   * 「字段缺失」与「字段为 false」在数据上完全一样，
   * 但含义相反 —— 前者是「不知道」，后者是「确认不是」。
   * 免费版 ip-api 就不返回 usageType / anycast / reverse。
   */
  signalsMissing?: string[]
}

/**
 * IP 质量判定。
 *
 * 这是整套指纹体系里性价比最高的一项：数据中心 IP 在 Google 与 X 都是一票否决，
 * 指纹做得再完美也救不回来。所以出口信息不能只解析 ip/country/city，
 * 必须把 usageType / hosting / proxy / mobile 拉出来并给出明确结论。
 */
export type IpQuality = 'residential' | 'mobile' | 'datacenter' | 'anonymizer' | 'unknown'

export interface IpQualityVerdict {
  quality: IpQuality
  /** 0-100，越高越像真实用户出口 */
  score: number
  /** 人类可读的问题列表，UI 直接展示 */
  issues: string[]
  /**
   * 本次判定**缺少**哪些信号（探测点没返回）。
   *
   * 必须显式暴露：免费版 ip-api 不返回 usageType / hosting 之外的
   * anycast / reverse 等字段，于是对应的判定分支永远不会触发。
   * 不标出来的话，用户看到「residential」会以为已经确认过用途，
   * 实际只是「没数据所以没扣分」—— 这是会误导决策的假安心。
   */
  degraded: string[]
  /** 是否应当阻止把该代理绑定到重要账号 */
  blocked: boolean
}

/** 出口质量判定依赖、但探测点未必提供的字段 */
export const QUALITY_SIGNAL_FIELDS = ['usageType', 'hosting', 'proxy', 'mobile', 'anycast', 'reverse'] as const

/**
 * 兜底推断：调用方直接构造 ExitInfo（没填 signalsMissing）时，从字段值反推哪些信号缺失。
 * 注意探测响应的字段名与 ExitInfo 并不完全一致（ip-api 的 proxy 映射成 isProxy），
 * 必须走这张表，否则 info['proxy'] 恒为 undefined，会把完整数据误报成缺信号。
 * 只推断 undefined/null：布尔为 false 无法区分「探测点说不是」与「探测点没返回」，
 * 那种情况由 parseExitInfo 从原始 JSON 记进 signalsMissing。
 */
const SIGNAL_TO_EXIT_KEY: Record<string, keyof ExitInfo> = {
  usageType: 'usageType',
  hosting: 'hosting',
  proxy: 'isProxy',
  mobile: 'mobile',
  anycast: 'anycast',
  reverse: 'reverse'
}

export function inferMissingSignals(info: ExitInfo): string[] {
  const out: string[] = []
  for (const f of QUALITY_SIGNAL_FIELDS) {
    const v = info[SIGNAL_TO_EXIT_KEY[f]]
    if (v === undefined || v === null) out.push(f)
  }
  return out
}

export function judgeIpQuality(info: ExitInfo | null): IpQualityVerdict {
  if (!info || !info.ip) {
    return { quality: 'unknown', score: 0, issues: ['尚未检测出口信息'], degraded: [], blocked: true }
  }
  const issues: string[] = []
  const degraded: string[] = []
  let score = 100
  let quality: IpQuality = 'residential'

  if (info.isProxy) {
    quality = 'anonymizer'
    score -= 70
    issues.push('出口被标记为匿名代理 / VPN（Google、X 会直接判为机器人流量）')
  }
  if (info.hosting) {
    if (quality === 'residential') quality = 'datacenter'
    score -= 55
    issues.push('出口属于机房 / 云服务商网段，不是住宅或蜂窝网络')
  }
  if (info.mobile) {
    quality = 'mobile'
    score = Math.min(100, score + 10)
  }
  if (info.anycast) {
    score -= 10
    issues.push('出口是 anycast 网段，出口国家可能与实际位置不一致')
  }
  const usage = (info.usageType ?? '').toUpperCase()
  if (usage && usage !== 'ISP' && usage !== 'MOBILE') {
    score -= 15
    issues.push(`ASN 用途为 ${usage}，不是普通住宅/ISP 用户`)
  }
  if (!info.usageType && !info.hosting && !info.isProxy && !info.mobile) {
    score -= 20
    issues.push('出口服务未返回用途信息，无法确认是住宅网络（建议换支持 usageType 的探测点）')
  }
  // 反向 DNS 带云厂商关键字是另一个稳定信号
  const rev = (info.reverse ?? '').toLowerCase()
  if (/(amazon|aws|azure|googleusercontent|hetzner|digitalocean|vultr|ovh|linode|scaleway|cloud)/.test(rev)) {
    if (quality === 'residential') quality = 'datacenter'
    score -= 30
    issues.push(`反向 DNS 指向云厂商：${info.reverse}`)
  }

  // 把「探测点没返回哪些信号」显式列出来，避免把「不知道」当成「确认不是」。
  // 优先用 parseExitInfo 记录的 signalsMissing（布尔字段无法区分缺失与 false）；
  // 没有该字段时退化成「按值推断」，这样任何直接构造的 ExitInfo 也不会静默丢掉降级信息。
  const missing = info.signalsMissing ?? inferMissingSignals(info)
  for (const f of missing) {
    if (!degraded.includes(f)) degraded.push(f)
  }
  if (degraded.length) {
    issues.push(`本次判定缺少信号：${degraded.join('、')}（置信度降低，建议换支持这些字段的探测点）`)
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  // 只有住宅与蜂窝出口可以放心登账号；机房 / 匿名代理 / 未知一律拦下
  const blocked = quality !== 'residential' && quality !== 'mobile'
  return { quality, score, issues, degraded, blocked }
}

/** 把探测响应体解析成出口信息；无法解析时返回 null 并给出原因 */
export function parseExitInfo(body: string): { info: ExitInfo | null; error: string | null } {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(body) as Record<string, unknown>
  } catch {
    return { info: null, error: '出口信息不是合法 JSON' }
  }
  if (json.status === 'fail') return { info: null, error: `出口查询失败：${String(json.message ?? '未知原因')}` }
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)
  const bool = (v: unknown): boolean => v === true || v === 1 || v === 'true'
  const ip = str(json.query) ?? null
  if (!ip) return { info: null, error: '出口信息中缺少 IP 字段' }
  const as = str(json.as)
  // ip-api 的 as 形如 "AS61726 Peer1 US LLC"，拆成编号与名称分别存
  const asMatch = as ? /^AS(\d+)\s*(.*)$/i.exec(as) : null
  // 记录探测点没返回的质量信号字段：布尔字段缺失与 false 无法区分，
  // 不记下来就会把「不知道」当成「确认不是」，给出虚高的分数。
  const signalsMissing = QUALITY_SIGNAL_FIELDS.filter((f) => json[f] === undefined || json[f] === null)
  return {
    info: {
      ip,
      country: str(json.country),
      region: str(json.regionName),
      city: str(json.city),
      isp: str(json.isp),
      timezone: str(json.timezone),
      asn: asMatch ? `AS${asMatch[1]}` : as?.startsWith('AS') ? as.split(' ')[0] : null,
      asName: asMatch?.[2] || str(json.org) || (as && !asMatch ? as : null),
      org: str(json.org),
      reverse: str(json.reverse),
      usageType: str(json.usageType),
      hosting: bool(json.hosting),
      isProxy: bool(json.proxy),
      mobile: bool(json.mobile),
      anycast: bool(json.anycast),
      signalsMissing
    },
    error: null
  }
}
