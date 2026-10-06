import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { openTunnel, type ProxyEndpoint } from '../proxy/checker'
import { parseClientHello, fingerprintHello, helloNeedsMoreBytes, type ClientHello, type TlsFingerprint } from './hello'
import { log, logError } from '../lib/log'

/**
 * TLS 观测 tap：一个本机 HTTP CONNECT 代理，在转发前偷看 ClientHello。
 *
 * 为什么必须走这条路：ClientHello 在 JS 层完全不可见（没有任何 API 能读到它），
 * 而 Google / X(Cloudflare) 恰恰在服务端记录它。唯一能看到它的时机，
 * 是连接经过我们手的时候 —— 所以把环境临时指向这个 tap，被动观测，
 * 观测完原样转发，不改写任何字节（改写就等于伪造，伪造的 ClientHello
 * 通常缺 GREASE，反而更像机器人）。
 *
 * 上游可选接真实代理：这样观测到的就是「环境真实的出口链路」，
 * 而不是「本机直连」的形状。
 */

export interface HelloObservation {
  host: string
  port: number
  hello: ClientHello
  fp: TlsFingerprint
  /** 是否经过上游代理链路 */
  viaUpstream: boolean
}

export interface TapOptions {
  upstream?: ProxyEndpoint
  timeoutMs?: number
  /**
   * 域名解析覆盖（host -> ip）。走 HTTP 代理时内核不做本地解析，
   * 由 tap 解析；本机自测源服务器需要把假域名指回 127.0.0.1。
   */
  resolve?: Record<string, string>
  onHello?: (o: HelloObservation) => void
}

export interface TapHandle {
  port: number
  /** 已观测到的连接数 */
  connections: number
  stop(): Promise<void>
}

const MAX_SNIFF_BYTES = 8192

function readConnectHead(buf: Buffer): { host: string; port: number } | null {
  const text = buf.toString('latin1')
  const lineEnd = text.indexOf('\r\n')
  if (lineEnd < 0) return null
  const line = text.slice(0, lineEnd)
  const m = /^CONNECT\s+(\S+):(\d+)\s+HTTP\/1\.[01]$/i.exec(line)
  if (!m) return null
  return { host: m[1], port: Number(m[2]) }
}

export async function startTap(opts: TapOptions = {}): Promise<TapHandle> {
  const timeoutMs = opts.timeoutMs ?? 15000
  let connections = 0
  // 记录所有活动 socket：stop() 必须能立刻收摊。
  // 内核的 H2 连接是 keep-alive 的，不主动断开的话 server.close() 会一直等，
  // 观测流程就被自己的 finally 卡住。
  const live = new Set<net.Socket>()

  const server = net.createServer((client) => {
    live.add(client)
    client.on('close', () => live.delete(client))
    let head = Buffer.alloc(0)
    let stage: 'head' | 'pipe' = 'head'

    const onData = (chunk: Buffer): void => {
      if (stage !== 'head') return
      head = Buffer.concat([head, chunk])
      const target = readConnectHead(head)
      if (!target) {
        // 绝对形式的普通请求（GET http://...）：TLS 观测用不上，直接拒绝，
        // 免得把「代理不支持普通 HTTP」伪装成网络故障
        if (head.length > 4096) {
          client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nProxy-Agent: fpb-tap\r\n\r\n')
          client.removeListener('data', onData)
          stage = 'pipe'
        }
        return
      }
      stage = 'pipe'
      client.removeListener('data', onData)
      log('tls-tap', `CONNECT ${target.host}:${target.port}`)
      void handleConnect(client, target, head.subarray(head.indexOf('\r\n\r\n') + 4))
    }

    client.on('data', onData)
    client.on('error', (e) => logError('tls-tap', '客户端连接异常', e))
    client.setTimeout(timeoutMs, () => client.destroy())
  })

  async function handleConnect(client: net.Socket, target: { host: string; port: number }, rest: Buffer): Promise<void> {
    let up: net.Socket
    try {
      if (opts.upstream) {
        const t = await openTunnel(opts.upstream, target, timeoutMs)
        up = t.sock
      } else {
        const host = opts.resolve?.[target.host] ?? target.host
        up = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.connect({ host, port: target.port })
          s.once('connect', () => resolve(s))
          s.once('error', reject)
          s.setTimeout(timeoutMs, () => s.destroy(new Error('上游连接超时')))
        })
      }
    } catch (e) {
      log('tls-tap', `无法连接 ${target.host}:${target.port}：${e instanceof Error ? e.message : e}`)
      client.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nProxy-Agent: fpb-tap\r\n\r\n')
      client.destroy()
      return
    }

    connections += 1
    live.add(up)
    client.write('HTTP/1.1 200 Connection established\r\n\r\n')
    // 上游 → 客户端方向必须在这里立刻接上：源服务器的 ServerHello 一旦到达，
    // 没有这条管道内核就永远等不到握手响应，表现为「导航超时」而不是明确错误 ——
    // 最难查的那种症状。（客户端 → 上游方向要等嗅探结束后再 pipe，见下方）
    up.pipe(client)

    // 偷看 ClientHello：攒够一个完整记录就解析，然后原样转发并转入纯管道
    let sniff = rest
    let sniffing = true
    const flush = (): void => {
      if (!sniffing) return
      log('tls-tap', `sniff len=${sniff.length} needMore=${helloNeedsMoreBytes(sniff)} first=${sniff.length ? sniff.subarray(0, 5).toString('hex') : ''}`)
      if (sniff.length > MAX_SNIFF_BYTES || !helloNeedsMoreBytes(sniff)) {
        sniffing = false
        try {
          const hello = parseClientHello(sniff)
          const fp = fingerprintHello(hello)
          opts.onHello?.({ host: target.host, port: target.port, hello, fp, viaUpstream: Boolean(opts.upstream) })
          log('tls-tap', `观测成功 ${target.host} ja4=${fp.ja4}`)
        } catch (e) {
          // 不是 TLS（明文 HTTP/其它协议）：不是错误，只是这一项观测不到
          log('tls-tap', `解析失败 ${target.host}: ${e instanceof Error ? e.message : e}`)
        }
        up.write(sniff)
        sniff = Buffer.alloc(0)
      }
    }

    const onClientData = (chunk: Buffer): void => {
      // 只在嗅探阶段被调用：转入管道前会摘掉这个监听，
      // 否则 pipe 与这里的 write 会把同一段字节写两遍，握手直接坏掉。
      sniff = Buffer.concat([sniff, chunk])
      flush()
      if (!sniffing) {
        client.removeListener('data', onClientData)
        client.pipe(up)
      }
    }

    client.on('data', onClientData)
    client.on('close', () => up.destroy())
    client.on('error', () => up.destroy())
    up.on('close', () => client.destroy())
    up.on('error', (e) => {
      log('tls-tap', `上游 ${target.host}:${target.port} 异常：${e instanceof Error ? e.message : e}`)
      client.destroy()
    })
    up.setTimeout(timeoutMs, () => up.destroy())
    client.setTimeout(timeoutMs, () => client.destroy())
    if (sniff.length) flush()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  server.on('error', (e) => logError('tls-tap', 'tap 服务错误', e))
  const port = (server.address() as AddressInfo).port
  log('tls-tap', `TLS 观测代理已启动 http://127.0.0.1:${port}${opts.upstream ? ' → 上游代理' : ' → 直连'}`)

  return {
    port,
    get connections() {
      return connections
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of live) s.destroy()
        live.clear()
        server.close(() => resolve())
      })
  }
}

/** 观测结果里对「本机自测」无意义的目标（IP / 单标签名）：SNI 本就不该出现 */
export function sniNotApplicable(host: string): boolean {
  if (/^\d+(\.\d+){3}$/.test(host) || /^[0-9a-f:]+$/i.test(host)) return true
  return !host.includes('.')
}