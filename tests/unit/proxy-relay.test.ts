import { describe, it, expect, afterAll } from 'vitest'
import net from 'node:net'
import {
  EXIT,
  startOrigin,
  startEchoOrigin,
  startHttpProxy,
  startSocks5Proxy,
  type Server
} from '../helpers/fake-proxies'
import { startRelay, type RelayHandle } from '../../src/main/proxy/relay'
import { probeProxy, parseExitInfo, type ProbeTarget } from '../../src/main/proxy/checker'

/**
 * 本地 relay 的端到端单测。
 *
 * relay 是「无认证 SOCKS5 入口 → 真实代理（可能带认证）」的转发器。
 * 测试用我们自己的 SOCKS5 客户端穿过 relay，等价于浏览器实际走的那条链路：
 * Chrome --proxy-server=socks5://127.0.0.1:<relay> → relay → 真实代理 → 目标。
 */

const open: Server[] = []
async function track<T extends Server>(s: Promise<T>): Promise<T> {
  const x = await s
  open.push(x)
  return x
}

afterAll(async () => {
  for (const s of open) await s.close()
})

describe('本地代理 relay', () => {
  it('无认证 HTTP 代理：穿过 relay 能拿到出口信息', async () => {
    const origin = await track(startOrigin())
    const upstream = await track(startHttpProxy())
    const relay: RelayHandle = await startRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port })
    try {
      const target: ProbeTarget = { host: '127.0.0.1', port: origin.port, path: '/json' }
      const r = await probeProxy({ scheme: 'socks5', host: '127.0.0.1', port: relay.port }, target)
      expect(r.error).toBeNull()
      expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
    } finally {
      await relay.stop()
    }
  })

  it('带认证 SOCKS5：Chrome 直连不支持认证，穿过 relay 才能通', async () => {
    const origin = await track(startOrigin())
    const upstream = await track(startSocks5Proxy({ username: 'u2', password: 'p2' }))
    const relay = await startRelay({
      scheme: 'socks5',
      host: '127.0.0.1',
      port: upstream.port,
      username: 'u2',
      password: 'p2'
    })
    try {
      const target: ProbeTarget = { host: '127.0.0.1', port: origin.port, path: '/json' }
      const r = await probeProxy({ scheme: 'socks5', host: '127.0.0.1', port: relay.port }, target)
      expect(r.ok).toBe(true)
      expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
    } finally {
      await relay.stop()
    }
  })

  it('带认证 HTTP 代理：relay 补上 Basic 凭据后可用', async () => {
    const origin = await track(startOrigin())
    const upstream = await track(startHttpProxy({ username: 'u1', password: 'p1' }))
    const relay = await startRelay({
      scheme: 'http',
      host: '127.0.0.1',
      port: upstream.port,
      username: 'u1',
      password: 'p1'
    })
    try {
      const target: ProbeTarget = { host: '127.0.0.1', port: origin.port, path: '/json' }
      const r = await probeProxy({ scheme: 'socks5', host: '127.0.0.1', port: relay.port }, target)
      expect(r.ok).toBe(true)
      expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
    } finally {
      await relay.stop()
    }
  })

  it('relay 按客户端指定的目标转发，不会写死地址', async () => {
    const echo = await track(startEchoOrigin())
    const upstream = await track(startHttpProxy())
    const relay = await startRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port })
    try {
      for (const path of ['/first', '/second']) {
        const r = await probeProxy(
          { scheme: 'socks5', host: '127.0.0.1', port: relay.port },
          { host: '127.0.0.1', port: echo.port, path }
        )
        expect(r.ok).toBe(true)
      }
      expect(echo.requests).toEqual(['/first', '/second'])
    } finally {
      await relay.stop()
    }
  })

  it('上游要求认证但 relay 没配凭据时明确失败，不挂死', async () => {
    const origin = await track(startOrigin())
    const upstream = await track(startSocks5Proxy({ username: 'u2', password: 'p2' }))
    const relay = await startRelay({ scheme: 'socks5', host: '127.0.0.1', port: upstream.port })
    try {
      const r = await probeProxy(
        { scheme: 'socks5', host: '127.0.0.1', port: relay.port },
        { host: '127.0.0.1', port: origin.port, path: '/json' },
        5000
      )
      expect(r.ok).toBe(false)
      expect(r.error).toContain('SOCKS5 连接失败')
    } finally {
      await relay.stop()
    }
  })

  it('stop() 后端口释放，可再次启动', async () => {
    const origin = await track(startOrigin())
    const upstream = await track(startHttpProxy())
    const first = await startRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port })
    const port = first.port
    await first.stop()

    const closed = await probeProxy(
      { scheme: 'socks5', host: '127.0.0.1', port },
      { host: '127.0.0.1', port: origin.port, path: '/json' },
      3000
    )
    expect(closed.ok).toBe(false)
    expect(closed.error).toContain('连接代理失败')

    const second = await startRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port })
    try {
      const r = await probeProxy(
        { scheme: 'socks5', host: '127.0.0.1', port: second.port },
        { host: '127.0.0.1', port: origin.port, path: '/json' }
      )
      expect(r.ok).toBe(true)
    } finally {
      await second.stop()
    }
  })

  it('并发穿过同一个 relay 不串数据', async () => {
    const echo = await track(startEchoOrigin())
    const upstream = await track(startHttpProxy())
    const relay = await startRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port })
    try {
      const paths = Array.from({ length: 12 }, (_, i) => `/p${i}`)
      const results = await Promise.all(
        paths.map((path) =>
          probeProxy(
            { scheme: 'socks5', host: '127.0.0.1', port: relay.port },
            { host: '127.0.0.1', port: echo.port, path }
          )
        )
      )
      for (const r of results) {
        expect(r.ok).toBe(true)
        expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
      }
      expect([...echo.requests].sort()).toEqual([...paths].sort())
    } finally {
      await relay.stop()
    }
  })

  it('拒绝 UDP ASSOCIATE（避免 WebRTC 绕过代理泄漏）', async () => {
    const upstream = await track(startHttpProxy())
    const relay = await startRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port })
    try {
      const sock = net.connect(relay.port, '127.0.0.1')
      const reply = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        sock.on('data', (d) => {
          chunks.push(d)
          const all = Buffer.concat(chunks)
          // 前 2 字节是认证应答，之后 10 字节才是命令应答
          if (all.length >= 12) resolve(all.subarray(2))
        })
        sock.on('error', reject)
        sock.on('connect', () => {
          sock.write(Buffer.from([0x05, 0x01, 0x00])) // 无认证
          // UDP ASSOCIATE (CMD=3)，目标 1.2.3.4:53
          sock.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 1, 2, 3, 4, 0, 53]))
        })
      })
      sock.destroy()
      expect(reply[0]).toBe(0x05)
      expect(reply[1]).toBe(0x07) // command not supported
    } finally {
      await relay.stop()
    }
  })
})
