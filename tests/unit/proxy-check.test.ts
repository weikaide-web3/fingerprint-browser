import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  EXIT,
  startOrigin,
  startFixedLengthOrigin,
  startHttpProxy,
  startSocks5Proxy,
  type Server
} from '../helpers/fake-proxies'
import { probeProxy, parseExitInfo, type ProbeTarget } from '../../src/main/proxy/checker'

/**
 * 代理探测的端到端单测：起真实的假代理服务器（HTTP CONNECT / SOCKS5），
 * 让探测代码真的走一遍 TCP + 握手 + 隧道内 HTTP，而不是只测纯函数。
 */

let origin: Server
let httpOpen: Server
let httpAuth: Server
let socksOpen: Server
let socksAuth: Server

beforeAll(async () => {
  origin = await startOrigin()
  httpOpen = await startHttpProxy()
  httpAuth = await startHttpProxy({ username: 'u1', password: 'p1' })
  socksOpen = await startSocks5Proxy()
  socksAuth = await startSocks5Proxy({ username: 'u2', password: 'p2' })
})

afterAll(async () => {
  for (const s of [origin, httpOpen, httpAuth, socksOpen, socksAuth]) await s.close()
})

function target(): ProbeTarget {
  return { host: '127.0.0.1', port: origin.port, path: '/json' }
}

describe('代理探测', () => {
  it('HTTP 代理（无认证）能拿到出口信息', async () => {
    const r = await probeProxy({ scheme: 'http', host: '127.0.0.1', port: httpOpen.port }, target())
    expect(r.error).toBeNull()
    expect(r.ok).toBe(true)
    expect(r.connectMs).toBeGreaterThanOrEqual(0)
    const { info, error } = parseExitInfo(r.body)
    expect(error).toBeNull()
    expect(info?.ip).toBe(EXIT.query)
    expect(info?.country).toBe('SG')
    expect(info?.timezone).toBe('Asia/Singapore')
  })

  it('HTTP 代理（Basic 认证）带正确凭据可通过', async () => {
    const r = await probeProxy(
      { scheme: 'http', host: '127.0.0.1', port: httpAuth.port, username: 'u1', password: 'p1' },
      target()
    )
    expect(r.ok).toBe(true)
    expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
  })

  it('HTTP 代理缺凭据时报认证类错误', async () => {
    const r = await probeProxy({ scheme: 'http', host: '127.0.0.1', port: httpAuth.port }, target())
    expect(r.ok).toBe(false)
    expect(r.error).toContain('认证')
  })

  it('HTTP 代理凭据错误时失败', async () => {
    const r = await probeProxy(
      { scheme: 'http', host: '127.0.0.1', port: httpAuth.port, username: 'u1', password: 'wrong' },
      target()
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('认证')
  })

  it('SOCKS5（无认证）能拿到出口信息', async () => {
    const r = await probeProxy({ scheme: 'socks5', host: '127.0.0.1', port: socksOpen.port }, target())
    expect(r.error).toBeNull()
    expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
  })

  it('SOCKS5（RFC1929 认证）带正确凭据可通过', async () => {
    const r = await probeProxy(
      { scheme: 'socks5', host: '127.0.0.1', port: socksAuth.port, username: 'u2', password: 'p2' },
      target()
    )
    expect(r.ok).toBe(true)
    expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
  })

  it('SOCKS5 凭据错误时报认证失败而不是超时', async () => {
    const r = await probeProxy(
      { scheme: 'socks5', host: '127.0.0.1', port: socksAuth.port, username: 'u2', password: 'nope' },
      target()
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('SOCKS5 认证失败')
  })

  it('端口不通时给出连接失败原因', async () => {
    const r = await probeProxy({ scheme: 'http', host: '127.0.0.1', port: 1 }, target(), 3000)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('连接代理失败')
  })

  it('协议不匹配时失败而不是挂死', async () => {
    // 对 SOCKS5 端口按 HTTP CONNECT 说话
    const r = await probeProxy({ scheme: 'http', host: '127.0.0.1', port: socksOpen.port }, target(), 3000)
    expect(r.ok).toBe(false)
  })

  it('出口服务返回 fail 时解析出原因', () => {
    const { info, error } = parseExitInfo(JSON.stringify({ status: 'fail', message: 'invalid query' }))
    expect(info).toBeNull()
    expect(error).toContain('invalid query')
  })

  it('定长（Content-Length）响应也能解析，不只是 chunked', async () => {
    const fixed = await startFixedLengthOrigin()
    try {
      const r = await probeProxy(
        { scheme: 'http', host: '127.0.0.1', port: httpOpen.port },
        { host: '127.0.0.1', port: fixed.port, path: '/json' }
      )
      expect(r.ok).toBe(true)
      expect(parseExitInfo(r.body).info?.ip).toBe('203.0.113.200')
    } finally {
      await fixed.close()
    }
  })

  it('并发探测互不干扰（Reader 不串数据）', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        probeProxy({ scheme: 'socks5', host: '127.0.0.1', port: socksAuth.port, username: 'u2', password: 'p2' }, target())
      )
    )
    for (const r of results) {
      expect(r.ok).toBe(true)
      expect(parseExitInfo(r.body).info?.ip).toBe(EXIT.query)
    }
  })
})