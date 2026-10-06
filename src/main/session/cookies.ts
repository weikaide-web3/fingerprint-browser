import type { CookieBundle, CookieFormat, CookieRecord, OriginStorage, ParseIssue } from '@shared/session'

/**
 * Cookie 序列化 / 反序列化。
 *
 * 两种格式都是业界事实标准，刻意不依赖第三方库：
 *   - Netscape cookies.txt：7 列制表符分隔（domain / 子域包含 / path / 过期 / secure / name / value），
 *     httpOnly 用 `#HttpOnly_` 前缀标记 —— Chrome 插件、curl、Puppeteer 都吃这一份。
 *   - Playwright storageState：`{ cookies, origins }` JSON，可携带 localStorage。
 * 解析器一律「坏行跳过并记录原因」，绝不因为一行脏数据就丢掉整包 cookie。
 */

const SAME_SITE = ['Strict', 'Lax', 'None'] as const

export function normalizeSameSite(v: unknown): CookieRecord['sameSite'] {
  if (typeof v === 'string') {
    const hit = SAME_SITE.find((s) => s.toLowerCase() === v.toLowerCase())
    if (hit) return hit
  }
  // 未标注时按浏览器默认（Chrome 默认 Lax）而不是 None，
  // 否则导入回来的 cookie 在跨站场景下会被静默丢弃。
  return 'Lax'
}

/** 把任意来源的 cookie 对象收敛成内部规范形态；字段非法时抛错由调用方记账 */
export function normalizeCookie(raw: unknown): CookieRecord {
  if (!raw || typeof raw !== 'object') throw new Error('cookie 不是对象')
  const c = raw as Record<string, unknown>
  const name = typeof c.name === 'string' ? c.name.trim() : ''
  if (!name) throw new Error('缺少 name')
  const domain = typeof c.domain === 'string' ? c.domain.trim() : ''
  if (!domain) throw new Error(`cookie ${name} 缺少 domain`)
  const path = typeof c.path === 'string' && c.path ? c.path : '/'
  const expiresRaw = typeof c.expires === 'number' ? c.expires : Number(c.expires ?? -1)
  const expires = Number.isFinite(expiresRaw) && expiresRaw > 0 ? Math.trunc(expiresRaw) : -1
  return {
    name,
    value: typeof c.value === 'string' ? c.value : String(c.value ?? ''),
    domain,
    path,
    expires,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: normalizeSameSite(c.sameSite)
  }
}

export function cookieKey(c: CookieRecord): string {
  return `${c.domain}\u0000${c.path}\u0000${c.name}`
}

/** 同名同域同路径以导入侧为准（与浏览器 Set-Cookie 覆盖语义一致） */
export function dedupeCookies(list: CookieRecord[]): CookieRecord[] {
  const map = new Map<string, CookieRecord>()
  for (const c of list) map.set(cookieKey(c), c)
  return [...map.values()]
}

export function mergeCookies(existing: CookieRecord[], incoming: CookieRecord[]): CookieRecord[] {
  return dedupeCookies([...existing, ...incoming])
}

export function toNetscape(cookies: CookieRecord[]): string {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# 由指纹浏览器导出：可直接被 Chrome 插件 / curl -b / Puppeteer 导入',
    '# 过期时间 -1 表示会话级 cookie（关闭浏览器即失效）'
  ]
  for (const c of cookies) {
    const domain = c.httpOnly ? `#HttpOnly_${c.domain}` : c.domain
    lines.push(
      [
        domain,
        // 子域包含标志：绝大多数站点 cookie 都作用于整域，与 Puppeteer 一致写 TRUE
        'TRUE',
        c.path,
        String(c.expires),
        c.secure ? 'TRUE' : 'FALSE',
        c.name,
        c.value
      ].join('\t')
    )
  }
  return lines.join('\n') + '\n'
}

export function parseNetscape(text: string): { cookies: CookieRecord[]; issues: ParseIssue[] } {
  const cookies: CookieRecord[] = []
  const issues: ParseIssue[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    let httpOnly = false
    let body = line
    if (body.startsWith('#HttpOnly_')) {
      httpOnly = true
      body = body.slice('#HttpOnly_'.length)
    } else if (body.startsWith('#')) continue

    const byTab = body.split('\t')
    const parts = byTab.length >= 7 ? byTab : body.split(/\s+/)
    if (parts.length < 7) {
      issues.push({ line, reason: `列数不足（需要 7 列，实际 ${parts.length}）` })
      continue
    }
    const [domain, , path, expiry, secure, name, ...rest] = parts
    try {
      cookies.push(
        normalizeCookie({
          domain,
          path,
          name,
          // value 里可能含制表符/空格，剩余列必须原样拼回
          value: rest.join('\t'),
          expires: Number(expiry),
          httpOnly,
          secure: secure.toUpperCase() === 'TRUE'
        })
      )
    } catch (e) {
      issues.push({ line, reason: (e as Error).message })
    }
  }
  return { cookies, issues }
}

export function toStorageState(bundle: CookieBundle): string {
  return JSON.stringify(
    {
      cookies: bundle.cookies.map((c) => ({ ...c })),
      origins: bundle.origins.map((o) => ({ origin: o.origin, localStorage: o.localStorage }))
    },
    null,
    2
  )
}

export function parseStorageState(text: string): { bundle: CookieBundle; issues: ParseIssue[] } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new Error(`storageState 不是合法 JSON：${(e as Error).message}`)
  }
  const obj = (json ?? {}) as Record<string, unknown>
  const issues: ParseIssue[] = []
  const cookies: CookieRecord[] = []
  const rawCookies = Array.isArray(obj.cookies) ? obj.cookies : []
  if (!Array.isArray(obj.cookies)) issues.push({ line: '(cookies)', reason: 'cookies 字段缺失或不是数组' })
  for (const c of rawCookies) {
    try {
      cookies.push(normalizeCookie(c))
    } catch (e) {
      issues.push({ line: JSON.stringify(c), reason: (e as Error).message })
    }
  }
  const origins: OriginStorage[] = []
  for (const item of Array.isArray(obj.origins) ? obj.origins : []) {
    const o = (item ?? {}) as Record<string, unknown>
    const origin = typeof o.origin === 'string' ? o.origin : ''
    if (!/^https?:\/\//i.test(origin)) {
      issues.push({ line: JSON.stringify(item), reason: 'origin 必须是 http(s) 绝对地址' })
      continue
    }
    const ls = Array.isArray(o.localStorage) ? o.localStorage : []
    origins.push({
      origin,
      localStorage: ls
        .map((x) => (x ?? {}) as Record<string, unknown>)
        .filter((x) => typeof x.name === 'string' && x.name)
        .map((x) => ({ name: x.name as string, value: String(x.value ?? '') }))
    })
  }
  return { bundle: { cookies, origins }, issues }
}

/** 自动嗅探：JSON 走 storageState，其余按 Netscape 解析 */
export function detectFormat(text: string): Exclude<CookieFormat, 'auto'> {
  return text.trimStart().startsWith('{') ? 'playwright' : 'netscape'
}

export function parseCookies(text: string, format: CookieFormat): {
  format: Exclude<CookieFormat, 'auto'>
  bundle: CookieBundle
  issues: ParseIssue[]
} {
  const resolved = format === 'auto' ? detectFormat(text) : format
  if (resolved === 'playwright') {
    const { bundle, issues } = parseStorageState(text)
    return { format: resolved, bundle: { cookies: dedupeCookies(bundle.cookies), origins: bundle.origins }, issues }
  }
  const { cookies, issues } = parseNetscape(text)
  return { format: resolved, bundle: { cookies: dedupeCookies(cookies), origins: [] }, issues }
}

/** 导出文件名：可读且能直接落到 Downloads */
export function bundleFilename(name: string, format: Exclude<CookieFormat, 'auto'>, ts: number): string {
  const safe = name.replace(/[^\w\-.]+/g, '_').slice(0, 40) || 'profile'
  return format === 'playwright' ? `${safe}-storage-state-${ts}.json` : `${safe}-cookies-${ts}.txt`
}
