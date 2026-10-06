import type { DetectItem, DetectStatus } from '@shared/detect'
import type { HttpRequestHeaders } from '@shared/http'
import type { FingerprintConfig } from '@shared/fingerprint'

/**
 * HTTP 请求头顺序 / 大小写 / 取值的一致性分析（纯函数，可完整单测）。
 *
 * 为什么顺序和大小写都重要：Chrome 的头部是由同一份 C++ 代码按固定顺序写出的，
 * 而且刻意把 sec-ch-ua* / sec-fetch-* 保持全小写、其余保持 Title-Case。
 * curl、Go net/http、Python requests、以及大部分「带认证的代理」改写后
 * 都会变成 Sec-Fetch-Site 这种 Title-Case —— 服务端一眼就能区分。
 *
 * 刻意不做的检查：不比对头部数量到具体数字（Chrome 会按场景增减），
 * 也不要求绝对索引相等（版本间会挪位），只比对**相对顺序不变量**，
 * 这样既不会因内核小版本升级误报，又能抓住「被中间设备重排」这类真问题。
 */

const G = 'HTTP 请求头'

/**
 * Chrome 导航请求的规范顺序与大小写（HTTP/1.1 线上形态）。
 * 顺序 = 数组下标；大小写 = 字符串本身。
 */
export const CHROME_HEADER_ORDER: string[] = [
  'Host',
  'Connection',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'Upgrade-Insecure-Requests',
  'User-Agent',
  'Accept',
  'Sec-Fetch-Site',
  'Sec-Fetch-Mode',
  'Sec-Fetch-User',
  'Sec-Fetch-Dest',
  'Accept-Encoding',
  'Accept-Language',
  'Cookie'
]

const CANON = new Map(CHROME_HEADER_ORDER.map((h) => [h.toLowerCase(), h]))

/** 中间设备注入的头部：出现即说明链路上有代理 / 网关在改写请求 */
const PROXY_INJECTED = ['via', 'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'proxy-connection']

/** 自动化工具常留下的痕迹头部 */
const AUTOMATION_MARKERS = ['x-puppeteer', 'x-playwright', 'x-selenium', 'x-driver', 'x-requested-with']

function item(key: string, label: string, expected: string, actual: string, status: DetectStatus, note?: string): DetectItem {
  return { group: G, key, label, expected, actual, status, ...(note ? { note } : {}) }
}

function indexOfName(req: HttpRequestHeaders, name: string): number {
  return req.headers.findIndex((h) => h.name === name)
}

/** 把 [a,b,c] 这类「必须依次出现」的约束展开成一条检查 */
function ordered(req: HttpRequestHeaders, names: string[]): { ok: boolean; actual: string } {
  const idx = names.map((n) => indexOfName(req, n))
  const present = idx.filter((i) => i >= 0)
  const actual = names.map((n, i) => (idx[i] >= 0 ? `${n}@${idx[i]}` : `${n}(缺)`)).join(' → ')
  if (!present.length) return { ok: false, actual }
  for (let i = 1; i < idx.length; i += 1) {
    // 允许中间缺项（例如非导航请求没有 Sec-Fetch-User），但已出现的必须保持相对顺序
    if (idx[i] >= 0 && idx[i - 1] >= 0 && idx[i] < idx[i - 1]) return { ok: false, actual }
  }
  return { ok: true, actual }
}

/** 按 Chrome 规则把 Client Hints 序列化成线上形态，用于与实测值比对 */
export function serializeClientHints(fp: FingerprintConfig): { ua: string; mobile: string; platform: string } | null {
  const ch = fp.clientHints
  if (!ch.enabled || !ch.brands.length) return null
  const ua = ch.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
  return { ua, mobile: ch.mobile ? '?1' : '?0', platform: `"${ch.platform}"` }
}

export interface HeaderAnalysisInput {
  request: HttpRequestHeaders
  /** profile 的指纹配置；缺省时只做顺序与污染检查 */
  fp: FingerprintConfig | null
}

/**
 * 分析一次观测到的请求头。
 *
 * 每一项都对应一个「服务端真的会看」的属性：
 * 顺序不变量、大小写、中间设备注入、以及与 profile 配置是否自洽。
 */
export function analyzeHeaders(input: HeaderAnalysisInput): DetectItem[] {
  const { request, fp } = input
  const out: DetectItem[] = []
  const names = request.headers.map((h) => h.name)
  const orderText = request.headers.map((h) => h.raw).join(' | ')

  out.push(item('http.method', '请求方法', 'GET', request.method, request.method === 'GET' ? 'ok' : 'unknown'))
  out.push(
    item(
      'http.headerCount',
      '请求头数量',
      '>= 8',
      String(request.headers.length),
      request.headers.length >= 8 ? 'ok' : 'mismatch',
      '真实 Chrome 的导航请求至少十几个头；数量过少是脚本客户端的典型形状'
    )
  )

  // --- 顺序不变量 ---
  const hostFirst = names.length > 0 && names[0] === 'host'
  out.push(item('http.order.hostFirst', 'Host 在最前', 'host@0', names.length ? `${names[0]}@0` : '—', hostFirst ? 'ok' : 'mismatch'))

  const pairs: [string, string, string, string][] = [
    [
      'http.order.uaBeforeAccept',
      'User-Agent 在 Accept 之前',
      'user-agent,accept',
      'Chrome 先写 UA 再写 Accept；curl / Go 常反过来'
    ],
    ['http.order.acceptBeforeSecFetch', 'Accept 在 Sec-Fetch-* 之前', 'accept,sec-fetch-site', 'Sec-Fetch 组在 Accept 之后是 Chrome 的固定形状'],
    [
      'http.order.secFetchGroup',
      'Sec-Fetch 组内部顺序',
      'sec-fetch-site,sec-fetch-mode,sec-fetch-user,sec-fetch-dest',
      '四个 Sec-Fetch 头必须按此顺序且相邻'
    ],
    [
      'http.order.encodingAfterSecFetch',
      'Accept-Encoding 在 Sec-Fetch 之后',
      'sec-fetch-dest,accept-encoding',
      'Chrome 把 Accept-Encoding 放在 Sec-Fetch 组之后'
    ],
    [
      'http.order.languageAfterEncoding',
      'Accept-Language 在 Accept-Encoding 之后',
      'accept-encoding,accept-language',
      '两者顺序颠倒是最常见的改写痕迹'
    ]
  ]
  for (const [key, label, list, note] of pairs) {
    const r = ordered(request, list.split(','))
    out.push(item(key, label, list, r.actual, r.ok ? 'ok' : 'mismatch', note))
  }

  // Cookie 必须真的是最后一个：单元素的 ordered() 永远不会失败，所以单独判定
  const cookieIdx = indexOfName(request, 'cookie')
  out.push(
    item(
      'http.order.cookieLast',
      'Cookie 在最后',
      `cookie@${request.headers.length - 1}`,
      cookieIdx >= 0 ? `cookie@${cookieIdx}` : '无 Cookie',
      cookieIdx < 0 || cookieIdx === request.headers.length - 1 ? 'ok' : 'mismatch',
      'Chrome 把 Cookie 放在最后；中间设备在其后追加 Via / X-Forwarded-* 会破坏这一点'
    )
  )

  const chIdx = indexOfName(request, 'sec-ch-ua')
  const uaIdx = indexOfName(request, 'user-agent')
  if (chIdx >= 0 && uaIdx >= 0) {
    out.push(
      item(
        'http.order.chBeforeUa',
        'Client Hints 头在 UA 之前',
        `sec-ch-ua@<${uaIdx}`,
        `sec-ch-ua@${chIdx}`,
        chIdx < uaIdx ? 'ok' : 'mismatch',
        'Chrome 89+ 把 sec-ch-ua* 放在 Upgrade-Insecure-Requests 之前；放最后说明头部被重排'
      )
    )
  }

  // --- 大小写 ---
  const caseIssues: string[] = []
  for (const h of request.headers) {
    const canon = CANON.get(h.name)
    if (canon && h.raw !== canon) caseIssues.push(`${h.raw}(应为 ${canon})`)
  }
  out.push(
    item(
      'http.nameCase',
      '头部名大小写符合 Chrome',
      CHROME_HEADER_ORDER.slice(1, 9).join(', '),
      caseIssues.length ? caseIssues.join(', ') : '全部符合',
      caseIssues.length === 0 ? 'ok' : 'mismatch',
      'Chrome 刻意把 sec-ch-ua* / sec-fetch-* 保持全小写；Go / curl / 多数代理会改成 Title-Case'
    )
  )

  const unknown = request.headers.filter((h) => !CANON.has(h.name)).map((h) => h.raw)
  if (unknown.length) {
    out.push(
      item(
        'http.unknownHeaders',
        '存在 Chrome 默认不发的头部',
        '无',
        unknown.join(', '),
        'unknown',
        '可能是 profile 的附加请求头（Network.setExtraHTTPHeaders 会追加在末尾），也可能是中间设备注入 —— 需要人工确认'
      )
    )
  }

  // --- 中间设备 / 自动化痕迹 ---
  const injected = request.headers.filter((h) => PROXY_INJECTED.includes(h.name))
  out.push(
    item(
      'http.noProxyHeaders',
      '无代理注入的头部',
      '无 Via / X-Forwarded-*',
      injected.length ? injected.map((h) => h.raw).join(', ') : '无',
      injected.length === 0 ? 'ok' : 'mismatch',
      'Via / X-Forwarded-* 说明链路上有代理或网关在改写请求；服务端据此能识别出多层代理，也会破坏「住宅 IP」的可信度'
    )
  )

  const markers = request.headers.filter((h) => AUTOMATION_MARKERS.includes(h.name))
  out.push(
    item(
      'http.noAutomationHeaders',
      '无自动化工具痕迹头部',
      '无',
      markers.length ? markers.map((h) => h.raw).join(', ') : '无',
      markers.length === 0 ? 'ok' : 'mismatch'
    )
  )

  const isNavigate = request.headers.find((h) => h.name === 'sec-fetch-mode')?.value === 'navigate'
  if (isNavigate) {
    const uir = indexOfName(request, 'upgrade-insecure-requests')
    out.push(
      item(
        'http.upgradeInsecureRequests',
        '导航请求带 Upgrade-Insecure-Requests',
        '1',
        uir >= 0 ? request.headers[uir].value || '—' : '缺失',
        uir >= 0 ? 'ok' : 'mismatch',
        '真实 Chrome 的地址栏导航一定带这个头；缺了就像 fetch() 或脚本请求'
      )
    )
  }

  if (request.httpVersion.startsWith('1')) {
    const conn = indexOfName(request, 'connection')
    out.push(
      item(
        'http.connectionHeader',
        'HTTP/1.1 带 Connection: keep-alive',
        'keep-alive',
        conn >= 0 ? request.headers[conn].value : '缺失',
        conn >= 0 && request.headers[conn].value.toLowerCase() === 'keep-alive' ? 'ok' : 'mismatch',
        'Chrome 的 HTTP/1.1 请求固定带 keep-alive；没有它多半是被代理重写了'
      )
    )
  }

  // --- 与 profile 配置自洽 ---
  if (fp) {
    const ua = request.headers.find((h) => h.name === 'user-agent')?.value
    out.push(
      item(
        'http.uaMatchesProfile',
        '线上 UA = profile 配置',
        fp.ua.ua,
        ua ?? '缺失',
        ua === fp.ua.ua ? 'ok' : 'mismatch',
        'UA 只在页面里改写而没走 CDP 覆盖时，请求头里的 UA 会露出内核真实版本'
      )
    )

    const al = request.headers.find((h) => h.name === 'accept-language')?.value
    out.push(
      item(
        'http.acceptLanguageMatchesProfile',
        '线上 Accept-Language = profile 配置',
        fp.language.acceptLanguage,
        al ?? '缺失',
        al === fp.language.acceptLanguage ? 'ok' : 'mismatch',
        'Accept-Language 与时区 / 页面语言不一致是低级别但确实会被用的信号'
      )
    )

    const ch = serializeClientHints(fp)
    if (ch) {
      const checks: [string, string, string, string][] = [
        ['http.secChUa', 'sec-ch-ua 与 profile 一致', 'sec-ch-ua', ch.ua],
        ['http.secChUaMobile', 'sec-ch-ua-mobile 与 profile 一致', 'sec-ch-ua-mobile', ch.mobile],
        ['http.secChUaPlatform', 'sec-ch-ua-platform 与 profile 一致', 'sec-ch-ua-platform', ch.platform]
      ]
      for (const [key, label, header, expected] of checks) {
        const actual = request.headers.find((h) => h.name === header)?.value
        if (actual === undefined) {
          out.push(item(key, label, expected, '缺失', 'mismatch', 'Client Hints 头缺失说明 UA 覆盖没生效'))
          continue
        }
        // 品牌顺序在不同 Chrome 版本间会变，因此比对集合而不是字符串
        const norm = (s: string): string =>
          s
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)
            .sort()
            .join(',')
        const same = header === 'sec-ch-ua' ? norm(actual) === norm(expected) : actual === expected
        out.push(item(key, label, expected, actual, same ? 'ok' : 'mismatch'))
      }
    }

    if (fp.headers.accept) {
      const actual = request.headers.find((h) => h.name === 'accept')?.value
      out.push(
        item('http.acceptMatchesProfile', 'Accept 与 profile 配置一致', fp.headers.accept, actual ?? '缺失', actual === fp.headers.accept ? 'ok' : 'mismatch')
      )
    }
    if (fp.headers.acceptEncoding) {
      const actual = request.headers.find((h) => h.name === 'accept-encoding')?.value
      out.push(
        item(
          'http.acceptEncodingMatchesProfile',
          'Accept-Encoding 与 profile 配置一致',
          fp.headers.acceptEncoding,
          actual ?? '缺失',
          actual === fp.headers.acceptEncoding ? 'ok' : 'mismatch',
          'Accept-Encoding 缺 zstd 说明内核版本低于 UA 声明的版本'
        )
      )
    }
  }

  out.push(item('http.order.raw', '完整头部顺序（原始）', '—', orderText, 'unknown', '与检测站看到的对一遍，确认没有多余或缺失的头部'))
  return out
}

export function summarizeHeaders(items: DetectItem[]): { ok: number; mismatch: number; unknown: number } {
  return {
    ok: items.filter((i) => i.status === 'ok').length,
    mismatch: items.filter((i) => i.status === 'mismatch').length,
    unknown: items.filter((i) => i.status === 'unknown').length
  }
}