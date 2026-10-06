import { describe, it, expect } from 'vitest'
import {
  analyzeHeaders,
  summarizeHeaders,
  serializeClientHints,
  CHROME_HEADER_ORDER
} from '../../src/main/http/headers'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import type { HttpRequestHeaders, HttpHeaderLine } from '@shared/http'
import type { FingerprintConfig } from '@shared/fingerprint'

/**
 * HTTP 请求头分析单测。
 *
 * 用「真实 Chrome 导航请求的形状」做基准（顺序 + 大小写都按线上抓包的样子写），
 * 再逐项注入中间设备会做的事（重排、Title-Case、追加 Via/X-Forwarded-*），
 * 确认每一项都能被抓出来 —— 这些正是 Google / Cloudflare 区分浏览器与脚本的输入。
 */

const fp: FingerprintConfig = generateFingerprint({
  seed: 'http-unit',
  os: 'Windows',
  locale: 'en-US',
  timezone: 'America/New_York',
  kernelVersion: '132.0.6834.110'
})

/** Chrome 在 HTTP/1.1 上发出的导航请求（大小写刻意保留原样） */
function chromeNavigate(overrides: Partial<Record<string, string>> = {}): HttpRequestHeaders {
  const value: Record<string, string> = {
    host: 'accounts.google.com',
    connection: 'keep-alive',
    'sec-ch-ua': fp.clientHints.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    'sec-ch-ua-mobile': fp.clientHints.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${fp.clientHints.platform}"`,
    'upgrade-insecure-requests': '1',
    'user-agent': fp.ua.ua,
    accept: fp.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'accept-encoding': fp.headers.acceptEncoding || 'gzip, deflate, br, zstd',
    'accept-language': fp.language.acceptLanguage,
    cookie: 'SID=abc; HSID=def'
  }
  Object.assign(value, overrides)
  const headers: HttpHeaderLine[] = CHROME_HEADER_ORDER.filter((h) => {
    const n = h.toLowerCase()
    return value[n] !== undefined && value[n] !== ''
  }).map((raw) => ({ raw, name: raw.toLowerCase(), value: value[raw.toLowerCase()] }))
  return { httpVersion: '1.1', method: 'GET', path: '/', headers }
}

const byKey = (items: ReturnType<typeof analyzeHeaders>, key: string) => items.find((i) => i.key === key)

describe('HTTP 请求头分析', () => {
  it('真实 Chrome 形状：无 mismatch', () => {
    const items = analyzeHeaders({ request: chromeNavigate(), fp })
    const bad = items.filter((i) => i.status === 'mismatch').map((i) => `${i.key}: 期望=${i.expected} 实测=${i.actual}`)
    expect(bad).toEqual([])
    expect(summarizeHeaders(items).ok).toBeGreaterThan(12)
  })

  it('serializeClientHints 产出线上形态', () => {
    const ch = serializeClientHints(fp)!
    expect(ch.mobile).toBe(fp.clientHints.mobile ? '?1' : '?0')
    expect(ch.platform).toBe(`"${fp.clientHints.platform}"`)
    expect(ch.ua).toContain(';v="')
    const off = structuredClone(fp)
    off.clientHints.enabled = false
    expect(serializeClientHints(off)).toBeNull()
  })

  it('Accept-Language 与 Accept-Encoding 颠倒 → 被指出', () => {
    const req = chromeNavigate()
    const iEnc = req.headers.findIndex((h) => h.name === 'accept-encoding')
    const iLang = req.headers.findIndex((h) => h.name === 'accept-language')
    const enc = req.headers[iEnc]
    req.headers[iEnc] = req.headers[iLang]
    req.headers[iLang] = enc
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.order.languageAfterEncoding')!.status).toBe('mismatch')
  })

  it('把 sec-ch-ua* 改成 Title-Case（Go / curl 的形状）→ 大小写检查失败', () => {
    const req = chromeNavigate()
    for (const h of req.headers) {
      if (h.name.startsWith('sec-ch-ua')) {
        h.raw = h.name
          .split('-')
          .map((p) => p[0].toUpperCase() + p.slice(1))
          .join('-')
      }
    }
    const items = analyzeHeaders({ request: req, fp })
    const c = byKey(items, 'http.nameCase')!
    expect(c.status).toBe('mismatch')
    expect(c.actual).toContain('Sec-Ch-Ua')
  })

  it('Sec-Fetch-* 被改成全小写（HTTP/2 归一化的形状）→ 也被指出', () => {
    const req = chromeNavigate()
    for (const h of req.headers) {
      if (h.name.startsWith('sec-fetch-')) h.raw = h.name
    }
    const items = analyzeHeaders({ request: req, fp })
    const c = byKey(items, 'http.nameCase')!
    expect(c.status).toBe('mismatch')
    expect(c.actual).toContain('sec-fetch-site')
  })

  it('代理追加 Via / X-Forwarded-For → 被指出', () => {
    const req = chromeNavigate()
    req.headers.push({ raw: 'Via', name: 'via', value: '1.1 proxy.example.com' })
    req.headers.push({ raw: 'X-Forwarded-For', name: 'x-forwarded-for', value: '1.2.3.4' })
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.noProxyHeaders')!.status).toBe('mismatch')
    // 追加在 Cookie 之后还会破坏「Cookie 在最后」
    expect(byKey(items, 'http.order.cookieLast')!.status).toBe('mismatch')
  })

  it('X-Puppeteer 之类的痕迹头部被指出', () => {
    const req = chromeNavigate()
    req.headers.push({ raw: 'X-Puppeteer', name: 'x-puppeteer', value: '1' })
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.noAutomationHeaders')!.status).toBe('mismatch')
  })

  it('sec-ch-ua* 被挪到末尾 → Client Hints 顺序检查失败', () => {
    const req = chromeNavigate()
    const ch = req.headers.filter((h) => h.name.startsWith('sec-ch-ua'))
    req.headers = req.headers.filter((h) => !h.name.startsWith('sec-ch-ua')).concat(ch)
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.order.chBeforeUa')!.status).toBe('mismatch')
  })

  it('UA 只在页面里改、请求头仍是内核真实版本 → 被抓出', () => {
    const req = chromeNavigate({
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.uaMatchesProfile')!.status).toBe('mismatch')
  })

  it('sec-ch-ua 缺失 → 说明 UA 覆盖没生效', () => {
    const req = chromeNavigate({ 'sec-ch-ua': '' })
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.secChUa')!.status).toBe('mismatch')
    expect(byKey(items, 'http.secChUa')!.actual).toBe('缺失')
  })

  it('sec-ch-ua 品牌顺序不同但集合相同 → 不误报', () => {
    const req = chromeNavigate()
    const h = req.headers.find((x) => x.name === 'sec-ch-ua')!
    h.value = h.value
      .split(',')
      .map((s) => s.trim())
      .reverse()
      .join(', ')
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.secChUa')!.status).toBe('ok')
  })

  it('HTTP/1.1 缺 Connection: keep-alive → 被指出', () => {
    const req = chromeNavigate({ connection: '' })
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.connectionHeader')!.status).toBe('mismatch')
  })

  it('头部数量过少（脚本客户端形状）→ 被指出', () => {
    const req: HttpRequestHeaders = {
      httpVersion: '1.1',
      method: 'GET',
      path: '/',
      headers: [
        { raw: 'Host', name: 'host', value: 'x.com' },
        { raw: 'User-Agent', name: 'user-agent', value: fp.ua.ua },
        { raw: 'Accept', name: 'accept', value: '*/*' }
      ]
    }
    const items = analyzeHeaders({ request: req, fp: null })
    expect(byKey(items, 'http.headerCount')!.status).toBe('mismatch')
    expect(byKey(items, 'http.order.hostFirst')!.status).toBe('ok')
  })

  it('非导航请求不要求 Upgrade-Insecure-Requests', () => {
    const req = chromeNavigate({ 'sec-fetch-mode': 'cors', 'upgrade-insecure-requests': '' })
    const items = analyzeHeaders({ request: req, fp })
    expect(byKey(items, 'http.upgradeInsecureRequests')).toBeUndefined()
  })

  it('未知头部只记为 unknown，不算不一致', () => {
    const req = chromeNavigate()
    req.headers.splice(-1, 0, { raw: 'DNT', name: 'dnt', value: '1' })
    const items = analyzeHeaders({ request: req, fp })
    const u = byKey(items, 'http.unknownHeaders')!
    expect(u.status).toBe('unknown')
    expect(u.actual).toContain('DNT')
  })
})