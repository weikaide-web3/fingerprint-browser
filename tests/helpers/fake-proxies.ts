import net from 'node:net'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 测试用的假代理 / 假出口服务。
 * 探测与 relay 的测试共用，保证两者面对的是同一套对端行为。
 */

export const EXIT = {
  status: 'success',
  query: '203.0.113.77',
  country: 'SG',
  regionName: 'Central',
  city: 'Singapore',
  isp: 'Fake ISP',
  timezone: 'Asia/Singapore'
}

export type Server = { port: number; close: () => Promise<void> }

/** 测试内的最小缓冲读取器 */
export class Buf {
  b = Buffer.alloc(0)
  private waiters: (() => void)[] = []
  constructor(sock: net.Socket) {
    sock.on('data', (d) => {
      this.b = Buffer.concat([this.b, d])
      const pending = this.waiters
      this.waiters = []
      for (const w of pending) w()
    })
  }
  async n(k: number): Promise<Buffer> {
    while (this.b.length < k) await new Promise<void>((r) => this.waiters.push(r))
    const out = this.b.subarray(0, k)
    this.b = this.b.subarray(k)
    return out
  }
  async until(marker: string): Promise<Buffer> {
    for (;;) {
      const i = this.b.indexOf(marker)
      if (i >= 0) {
        const out = this.b.subarray(0, i + marker.length)
        this.b = this.b.subarray(i + marker.length)
        return out
      }
      await new Promise<void>((r) => this.waiters.push(r))
    }
  }
  /** 停止自行消费数据，把 socket 交给 pipe() */
  detach(sock: net.Socket): void {
    sock.removeAllListeners('data')
  }
}

export function listen(server: net.Server): Promise<Server> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

export function startOrigin(): Promise<Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(EXIT))
  })
  return listen(server as unknown as net.Server)
}

/** 显式带 Content-Length 的出口服务，用于覆盖非 chunked 分支 */
export function startFixedLengthOrigin(query = '203.0.113.200'): Promise<Server> {
  const server = http.createServer((_req, res) => {
    const body = JSON.stringify({ ...EXIT, query })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  })
  return listen(server as unknown as net.Server)
}

/** 记录被转发到的目标，用于断言 relay 真的把请求送到了对的地方 */
export function startEchoOrigin(): Promise<Server & { requests: string[] }> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(EXIT))
  })
  return listen(server as unknown as net.Server).then((s) => ({ ...s, requests }))
}

export function startSocks5Proxy(auth?: { username: string; password: string }): Promise<Server> {
  const server = net.createServer((sock) => {
    const buf = new Buf(sock)
    void (async () => {
      const greet = await buf.n(2)
      const methods = await buf.n(greet[1])
      let chosen = 0
      if (auth) {
        if (!methods.includes(0x02)) {
          sock.end(Buffer.from([0x05, 0xff]))
          return
        }
        chosen = 0x02
      }
      sock.write(Buffer.from([0x05, chosen]))
      if (chosen === 0x02 && auth) {
        await buf.n(1)
        const ul = (await buf.n(1))[0]
        const user = (await buf.n(ul)).toString('utf8')
        const pl = (await buf.n(1))[0]
        const pass = (await buf.n(pl)).toString('utf8')
        const ok = user === auth.username && pass === auth.password
        sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
        if (!ok) {
          sock.destroy()
          return
        }
      }
      const req = await buf.n(4)
      const atyp = req[3]
      let host = ''
      if (atyp === 0x01) host = (await buf.n(4)).join('.')
      else if (atyp === 0x03) host = (await buf.n((await buf.n(1))[0])).toString('utf8')
      else {
        sock.destroy()
        return
      }
      const port = (await buf.n(2)).readUInt16BE(0)
      const up = net.connect(port, host, () => {
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        buf.detach(sock)
        if (buf.b.length) up.write(buf.b)
        up.pipe(sock)
        sock.pipe(up)
      })
      up.on('error', () => {
        sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        sock.destroy()
      })
    })()
  })
  return listen(server)
}
export function startHttpProxy(auth?: { username: string; password: string }): Promise<Server> {
  const server = net.createServer((sock) => {
    const buf = new Buf(sock)
    void (async () => {
      const headBuf = await buf.until('\r\n\r\n').catch(() => null)
      if (!headBuf) return
      const text = headBuf.toString('latin1')
      const [method, authority] = text.split('\r\n')[0].split(' ')
      if (method !== 'CONNECT') {
        sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (auth) {
        const want = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
        // 只能小写头名，base64 的值本身大小写敏感
        const got = text
          .split('\r\n')
          .find((l) => l.toLowerCase().startsWith('proxy-authorization:'))
          ?.slice('proxy-authorization:'.length)
          .trim()
        if (got !== want) {
          sock.end(
            'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
          )
          return
        }
      }
      const at = authority.lastIndexOf(':')
      const host = authority.slice(0, at)
      const port = Number(authority.slice(at + 1))
      const up = net.connect(port, host, () => {
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n')
        buf.detach(sock)
        if (buf.b.length) up.write(buf.b)
        up.pipe(sock)
        sock.pipe(up)
      })
      up.on('error', () => {
        sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        sock.destroy()
      })
    })()
  })
  return listen(server)
}