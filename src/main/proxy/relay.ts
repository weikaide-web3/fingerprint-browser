import net from 'node:net'
import { openTunnel, Reader, type ProxyEndpoint } from './checker'
import { log, logError } from '../lib/log'

/**
 * 本地代理 relay：在 127.0.0.1 上开一个无认证 SOCKS5 入口，
 * 转发时补上真实代理需要的账号密码。
 *
 * 为什么必须有它：Chrome 的 --proxy-server 不接受凭据——HTTP 代理会弹认证窗，
 * SOCKS5 认证则完全不支持。
 *
 * 为什么入口是 SOCKS5 而不是 HTTP：Chrome 对 HTTP 代理的明文请求发的是
 * absolute-form（GET http://host/path），要正确转发就得逐条改写请求行并处理
 * keep-alive 分帧；而 SOCKS5 是连接级协议，HTTP / HTTPS / WS 一律按
 * host:port 转发，不需要碰任何 HTTP 报文。顺带还统一了 UDP 的处理入口。
 *
 * relay 复用 openTunnel，与「检测」走同一段握手代码，因此检测通过的代理
 * 在浏览器里不会突然不通。
 */

export interface RelayHandle {
  port: number
  stop(): Promise<void>
}

/** SOCKS5 请求头固定 4 字节 + 变长地址 + 2 字节端口 */
const REP = {
  OK: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  REFUSED: 0x05,
  CMD_UNSUPPORTED: 0x07,
  ATYP_UNSUPPORTED: 0x08
} as const

function fail(sock: net.Socket, rep: number): void {
  sock.end(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
}

async function handleClient(sock: net.Socket, ep: ProxyEndpoint, timeoutMs: number): Promise<void> {
  const reader = new Reader(sock)
  const greeting = await reader.exact(2, timeoutMs)
  if (greeting[0] !== 0x05) {
    fail(sock, REP.GENERAL_FAILURE)
    return
  }
  const methods = await reader.exact(greeting[1], timeoutMs)
  // 只接受「无认证」：凭据由 relay 补，浏览器侧不需要知道
  if (!methods.includes(0x00)) {
    sock.end(Buffer.from([0x05, 0xff]))
    return
  }
  sock.write(Buffer.from([0x05, 0x00]))

  const req = await reader.exact(4, timeoutMs)
  if (req[0] !== 0x05) {
    fail(sock, REP.GENERAL_FAILURE)
    return
  }
  if (req[1] !== 0x01) {
    // BIND / UDP ASSOCIATE 都不支持。拒绝 UDP 顺带避免了 WebRTC 绕过代理泄漏。
    fail(sock, REP.CMD_UNSUPPORTED)
    return
  }

  let host = ''
  if (req[3] === 0x01) host = (await reader.exact(4, timeoutMs)).join('.')
  else if (req[3] === 0x04) host = (await reader.exact(16, timeoutMs)).toString('hex').replace(/(.{4})/g, '$1:').replace(/:$/, '')
  else if (req[3] === 0x03) host = (await reader.exact((await reader.exact(1, timeoutMs))[0], timeoutMs)).toString('utf8')
  else {
    fail(sock, REP.ATYP_UNSUPPORTED)
    return
  }
  const portBuf = await reader.exact(2, timeoutMs)
  const port = portBuf.readUInt16BE(0)
  if (!host || !port) {
    fail(sock, REP.GENERAL_FAILURE)
    return
  }

  let tunnel
  try {
    tunnel = await openTunnel(ep, { host, port }, timeoutMs)
  } catch (e) {
    logError('proxy-relay', `转发 ${host}:${port} → ${ep.scheme}://${ep.host}:${ep.port} 失败`, e)
    fail(sock, REP.REFUSED)
    return
  }

  // 先 detach 再 pipe：否则 Reader 的 data 监听与 pipe 会各自收到同一份 chunk，
  // 导致转发内容重复。
  reader.detach()
  tunnel.reader.detach()

  sock.write(Buffer.from([0x05, REP.OK, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
  const fromUpstream = tunnel.reader.pending()
  if (fromUpstream.length) sock.write(fromUpstream)
  const fromClient = reader.pending()
  if (fromClient.length) tunnel.sock.write(fromClient)

  tunnel.sock.on('error', () => sock.destroy())
  sock.on('error', () => tunnel.sock.destroy())
  sock.on('close', () => tunnel.sock.destroy())
  tunnel.sock.pipe(sock)
  sock.pipe(tunnel.sock)
}

export async function startRelay(
  ep: ProxyEndpoint,
  opts: { timeoutMs?: number; preferredPort?: number } = {}
): Promise<RelayHandle> {
  const timeoutMs = opts.timeoutMs ?? 20000
  const clients = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    clients.add(sock)
    sock.on('close', () => clients.delete(sock))
    void handleClient(sock, ep, timeoutMs).catch((e: unknown) => {
      logError('proxy-relay', '会话处理异常', e)
      sock.destroy()
    })
  })

  // 指定端口被占用时退回随机端口：relay 端口写进 --proxy-server，
  // 固定端口便于排查，但不该因为冲突而让环境开不起来。
  const preferred = opts.preferredPort && opts.preferredPort > 0 ? opts.preferredPort : 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  }).catch((e: unknown) => {
    if (!preferred) throw e
    log('proxy-relay', `指定端口 ${preferred} 被占用，改用随机端口：${e instanceof Error ? e.message : e}`)
    return new Promise<void>((resolve, reject) => {
      server.removeAllListeners('error')
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  })
  server.on('error', (e) => logError('proxy-relay', 'relay 服务错误', e))

  const port = (server.address() as net.AddressInfo).port
  log('proxy-relay', `socks5://127.0.0.1:${port} → ${ep.scheme}://${ep.host}:${ep.port}`)

  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.destroy()
        clients.clear()
        server.close(() => resolve())
      })
  }
}