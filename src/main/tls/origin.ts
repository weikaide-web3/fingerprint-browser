import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import { fingerprintFromFrames, parseFrames, FRAME, H2_PREFACE, type Frame } from './http2'
import { probeCert, PROBE_HOST, type ProbeCert } from './cert'
import { log, logError } from '../lib/log'
import type { HttpHeaderLine } from '@shared/http'
import type { Http2Fingerprint, HttpRequestHeaders } from '@shared/tls'

/**
 * 本机 TLS 源服务器（自己终结 TLS + 自己解析 HTTP/2 帧）。
 *
 * 为什么需要它：HTTP/2 的 SETTINGS / 优先级 / WINDOW_UPDATE 全在 TLS 之内，
 * 被动 tap 看不到。只有我们自己当服务器，才能读到内核发出的前置帧序列。
 *
 * 为什么不用 node 的 http2 服务器（实测结论）：
 *  1. 它在 'secureConnection' 的内部监听器里**同步**创建 session 并接管 socket，
 *     外部后挂的 'data' 监听器一个字节都收不到（见 tmp-h2getter.test.ts）；
 *  2. 'session' 事件因此早于我们自己的 'secureConnection' 监听器触发，
 *     按 socket 关联会话会全部落空（日志里的「会话没有对应的嗅探记录」就是它）；
 *  3. 即便读到 session.remoteSettings，也只有「值集合」，
 *     **没有 SETTINGS 顺序、没有优先级树、没有 WINDOW_UPDATE** ——
 *     而这三样恰恰是 Akamai / Cloudflare 实际比对的东西。
 * 所以这里直接用 node:tls 拿解密后的原始字节，自己按帧切。
 *
 * 响应侧只实现「够用的最小 HTTP/2」：SETTINGS + ACK + 用 HPACK 静态表编码的
 * :status 200 / content-type，足以让内核正常渲染页面而不报协议错误。
 */

export interface OriginSessionInfo {
  host: string
  alpn: string | null
  tlsVersion: string | null
  cipher: string | null
  h2: Http2Fingerprint
  /** 'raw' = 含帧顺序的完整指纹；'none' = 没读到前置帧 */
  h2Source: 'raw' | 'none'
  /**
   * 内核实际发出的请求头（含顺序）。
   * 只有 http/1.1 那条连接能拿到：h2 的头部走 HPACK，
   * 自己实现 Huffman + 动态表解码的成本远高于收益，
   * 而 Chrome 两条链路的头部**构造顺序是同一份代码产出的**，
   * 所以用 http/1.1 观测顺序即可代表真实顺序。
   */
  request: HttpRequestHeaders | null
}

/** 一次请求的头部观测：顺序即线上顺序 */

export interface OriginHandle {
  port: number
  host: string
  url: string
  cert: ProbeCert
  sessions: OriginSessionInfo[]
  /** 该监听器提供的 ALPN：'h2' 用于 HTTP/2 形状，'http/1.1' 用于请求头顺序 */
  alpn: string[]
  stop(): Promise<void>
}

/** 一次最多解析多少前置帧：Chrome 的前置序列很小，超了说明把无关连接卷进来了 */
const FRAME_LIMIT = 64
const BODY = '<!doctype html><meta charset=utf-8><title>tls-probe</title><body>ok</body>'

/** HPACK 静态表：8 = ":status: 200"，31 = "content-type: text/html" */
const RESP_HEADERS = Buffer.from([0x80 | 8, 0x80 | 31])

function frame(type: number, flags: number, stream: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(9)
  head[0] = (payload.length >> 16) & 0xff
  head[1] = (payload.length >> 8) & 0xff
  head[2] = payload.length & 0xff
  head[3] = type
  head[4] = flags
  head.writeUInt32BE(stream & 0x7fffffff, 5)
  return Buffer.concat([head, payload])
}

/** 服务器侧 SETTINGS：只发必要项，避免反过来影响对端的形状 */
const SERVER_SETTINGS = Buffer.from([
  0x00, 0x03, 0x00, 0x00, 0xff, 0xff, // MAX_CONCURRENT_STREAMS = 65535
  0x00, 0x04, 0x00, 0x04, 0x00, 0x00 // INITIAL_WINDOW_SIZE = 262144
])

/**
 * http/1.1 分支：只为了读请求头顺序。
 * 头部是明文，不需要 HPACK 解码；读完立刻回一个最小响应并关闭连接，
 * 避免 Chrome 复用连接导致后续请求把观测数据搅乱。
 */
function handleHttp11(sock: tls.TLSSocket, sessions: OriginSessionInfo[], sockets: Set<tls.TLSSocket>): void {
  const info: OriginSessionInfo = {
    host: PROBE_HOST,
    alpn: 'http/1.1',
    tlsVersion: typeof sock.getProtocol === 'function' ? (sock.getProtocol() || null) : null,
    cipher: typeof sock.getCipher === 'function' ? (sock.getCipher()?.name ?? null) : null,
    h2: { preface: false, settings: [], priorities: [], preludeFrames: [], windowUpdate: null, fp: '' },
    h2Source: 'none',
    request: null
  }
  sessions.push(info)
  sockets.add(sock)

  let pending = Buffer.alloc(0)
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    const head = pending.subarray(0, Math.min(pending.length, 8192)).toString('latin1')
    const sep = head.indexOf('\r\n\r\n')
    const block = sep >= 0 ? head.slice(0, sep) : head
    const lines = block.split('\r\n')
    const [line, ...headerLines] = lines
    const m = /^(\S+)\s+(\S+)\s+HTTP\/([\d.]+)$/i.exec(line ?? '')
    if (!m) {
      log('tls-origin', `http/1.1 请求行解析失败：${(line ?? '').slice(0, 60)}`)
    } else {
      const headers: HttpHeaderLine[] = []
      for (const l of headerLines) {
        const idx = l.indexOf(':')
        if (idx <= 0) continue
        const raw = l.slice(0, idx).trim()
        headers.push({ raw, name: raw.toLowerCase(), value: l.slice(idx + 1).trim() })
      }
      info.request = { httpVersion: `1.${m[3]}`, method: m[1], path: m[2], headers }
      log('tls-origin', `请求头顺序（${headers.length} 项）：${headers.map((h) => h.raw).join(' | ')}`)
    }
    const body = Buffer.from(BODY)
    const resp =
      'HTTP/1.1 200 OK\r\n' +
      'content-type: text/html; charset=utf-8\r\n' +
      `content-length: ${body.length}\r\n` +
      'connection: close\r\n\r\n'
    try {
      sock.write(resp)
      sock.end(body)
    } catch (e) {
      log('tls-origin', `http/1.1 响应失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  sock.on('data', (chunk: Buffer) => {
    if (done) return
    pending = Buffer.concat([pending, chunk])
    if (pending.includes('\r\n\r\n') || pending.length > 16384) finish()
  })
  sock.on('error', (e) => log('tls-origin', `http/1.1 连接错误：${e.message}`))
  sock.on('close', () => {
    sockets.delete(sock)
    finish()
  })
}

function handleConnection(sock: tls.TLSSocket, sessions: OriginSessionInfo[], sockets: Set<tls.TLSSocket>): void {
  // ALPN 协商成 http/1.1 时走明文头部分支：这里要的是请求头顺序，不是 H2 形状
  if (sock.alpnProtocol === 'http/1.1') {
    handleHttp11(sock, sessions, sockets)
    return
  }
  const info: OriginSessionInfo = {
    host: PROBE_HOST,
    alpn: sock.alpnProtocol || null,
    tlsVersion: typeof sock.getProtocol === 'function' ? (sock.getProtocol() || null) : null,
    cipher: typeof sock.getCipher === 'function' ? (sock.getCipher()?.name ?? null) : null,
    h2: { preface: false, settings: [], priorities: [], preludeFrames: [], windowUpdate: null, fp: 'S=;P=;A=;W=' },
    h2Source: 'none',
    request: null
  }
  sessions.push(info)
  sockets.add(sock)

  let pending = Buffer.alloc(0)
  let prefaceSeen = false
  let settled = false
  const collected: Frame[] = []

  const settle = (): void => {
    if (settled) return
    settled = true
    const fp = fingerprintFromFrames(collected)
    if (fp && (fp.settings.length || fp.priorities.length || fp.windowUpdate !== null)) {
      info.h2 = fp
      info.h2Source = 'raw'
      log('tls-origin', `H2 指纹：${fp.fp}`)
    } else {
      log('tls-origin', `未读到有效的 H2 前置帧（frames=${collected.length} alpn=${info.alpn ?? '?'}）`)
    }
  }

  const respond = (stream: number): void => {
    if (sock.destroyed || sock.writableEnded) return
    try {
      // HEADERS 带 END_HEADERS(0x04)，随后 DATA 带 END_STREAM(0x01)
      sock.write(frame(FRAME.HEADERS, 0x04, stream, RESP_HEADERS))
      sock.write(frame(FRAME.DATA, 0x01, stream, Buffer.from(BODY)))
    } catch (e) {
      log('tls-origin', `响应失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  sock.on('data', (chunk: Buffer) => {
    try {
      // 只 append 一次：之前这里在前置分支后又拼了一次同一个 chunk，
      // 导致帧流里出现重复字节，SETTINGS 之后的帧全部错位解析失败。
      pending = Buffer.concat([pending, chunk])
      if (!prefaceSeen) {
        if (pending.length < H2_PREFACE.length) return
        if (pending.subarray(0, H2_PREFACE.length).toString('latin1') !== H2_PREFACE) {
          log('tls-origin', `不是 h2 连接（head=${pending.subarray(0, 24).toString('hex')}）`)
          pending = Buffer.alloc(0)
          prefaceSeen = true // 停止等待前置，避免一直拼缓冲
          return
        }
        pending = pending.subarray(H2_PREFACE.length)
        prefaceSeen = true
        if (!sock.destroyed) sock.write(frame(FRAME.SETTINGS, 0, 0, SERVER_SETTINGS))
      }
      const { frames, consumed } = parseFrames(pending, FRAME_LIMIT)
      if (!frames.length) return
      pending = pending.subarray(consumed)
      for (const f of frames) {
        collected.push(f)
        if (f.type === FRAME.SETTINGS && !(f.flags & 0x1)) {
          if (!sock.destroyed) sock.write(frame(FRAME.SETTINGS, 0x1, 0, Buffer.alloc(0)))
        }
        if (f.type === FRAME.HEADERS) respond(f.stream)
      }
      // HEADERS 之后前置序列必然结束：立刻定稿，避免把请求帧混进指纹
      if (collected.some((f) => f.type === FRAME.HEADERS)) settle()
    } catch (e) {
      // 观测绝不能把真实连接搞崩
      logError('tls-origin', 'H2 帧解析异常', e)
      settle()
    }
  })
  sock.on('error', (e) => log('tls-origin', `连接错误：${e.message}`))
  sock.on('close', () => {
    sockets.delete(sock)
    settle()
  })
}

export async function startOrigin(opts: { host?: string; alpn?: string[] } = {}): Promise<OriginHandle> {
  const cert = probeCert()
  if (!cert) throw new Error('无法生成观测用自签证书（openssl 不可用？）')
  const host = opts.host ?? PROBE_HOST
  // 只提供 h2：否则内核可能协商到 http/1.1，H2 指纹就永远采不到。
  // 想观测请求头顺序时另开一个只提供 http/1.1 的监听器 —— 头部在 h2 里走
  // HPACK（要自己实现 Huffman + 动态表才解得开），而 Chrome 两条链路的
  // **头部构造顺序出自同一份代码**，所以 http/1.1 上采到的顺序就是真实顺序。
  const alpn = opts.alpn ?? ['h2']
  const sessions: OriginSessionInfo[] = []
  const sockets = new Set<tls.TLSSocket>()

  const server = tls.createServer({
    key: cert.key,
    cert: cert.cert,
    ALPNProtocols: alpn
  })

  server.on('secureConnection', (sock) => handleConnection(sock, sessions, sockets))
  server.on('tlsClientError', (e) => log('tls-origin', `tlsClientError: ${e instanceof Error ? e.message : e}`))
  server.on('error', (e) => logError('tls-origin', '观测服务器错误', e))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const port = (server.address() as AddressInfo).port
  log('tls-origin', `HTTP/2 观测服务器已启动 https://${host}:${port}`)

  return {
    port,
    host,
    url: `https://${host}:${port}/`,
    cert,
    alpn,
    sessions,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.close(() => resolve())
        server.unref()
      })
  }
}
