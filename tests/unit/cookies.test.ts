import { describe, it, expect } from 'vitest'
import {
  bundleFilename,
  dedupeCookies,
  detectFormat,
  mergeCookies,
  normalizeCookie,
  normalizeSameSite,
  parseCookies,
  parseNetscape,
  parseStorageState,
  toNetscape,
  toStorageState
} from '../../src/main/session/cookies'
import type { CookieRecord } from '@shared/session'

const cookie = (over: Partial<CookieRecord> = {}): CookieRecord => ({
  name: 'sid',
  value: 'abc',
  domain: 'example.com',
  path: '/',
  expires: 1_800_000_000,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  ...over
})

describe('Netscape cookies.txt', () => {
  it('导出遵循 7 列格式，httpOnly 用 #HttpOnly_ 前缀', () => {
    const text = toNetscape([cookie(), cookie({ name: 'theme', value: 'dark', httpOnly: false, secure: false })])
    const lines = text.split('\n').filter((l) => l && !l.startsWith('# '))
    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith('#HttpOnly_')).toBe(true)
    expect(lines[0].split('\t')).toHaveLength(7)
    expect(lines[1].startsWith('#HttpOnly_')).toBe(false)
  })

  it('导出→解析完全往返（含 httpOnly / secure / sameSite / 会话级过期）', () => {
    const src = [
      cookie(),
      cookie({ name: 'sess', expires: -1, secure: false }),
      cookie({ name: 'spaced', value: 'has space\tand tab' }),
      cookie({ name: 'sub', domain: '.example.org', sameSite: 'None' })
    ]
    const { cookies, issues } = parseNetscape(toNetscape(src))
    expect(issues).toEqual([])
    expect(cookies).toHaveLength(src.length)
    const byName = new Map(cookies.map((c) => [c.name, c]))
    expect(byName.get('sid')!.httpOnly).toBe(true)
    expect(byName.get('sid')!.secure).toBe(true)
    expect(byName.get('sess')!.expires).toBe(-1)
    // value 里的制表符必须原样回来，否则导入后登录态直接失效
    expect(byName.get('spaced')!.value).toBe('has space\tand tab')
    expect(byName.get('sub')!.domain).toBe('.example.org')
  })

  it('脏行只跳过并记录原因，不吞掉整包 cookie', () => {
    const text = [
      '# comment',
      'bad\tline',
      '#HttpOnly_example.com\tTRUE\t/\t1800000000\tTRUE\tsid\tv1',
      '',
      '   ',
      'nope.com\tTRUE\t/\tnotanumber\tFALSE\tx\ty'
    ].join('\n')
    const { cookies, issues } = parseNetscape(text)
    expect(cookies).toHaveLength(2)
    expect(cookies[0].name).toBe('sid')
    expect(cookies[0].httpOnly).toBe(true)
    // 过期时间非法 → 降级为会话级而不是丢弃
    expect(cookies[1].expires).toBe(-1)
    expect(issues.map((i) => i.reason).some((r) => r.includes('列数不足'))).toBe(true)
  })

  it('空格分隔的变体也能解析（部分插件导出用空格）', () => {
    const { cookies } = parseNetscape('example.com TRUE / 1800000000 FALSE sid abc')
    expect(cookies[0].name).toBe('sid')
    expect(cookies[0].domain).toBe('example.com')
  })
})

describe('Playwright storageState', () => {
  it('解析 cookies + origins，非法 origin 记为问题', () => {
    const { bundle, issues } = parseStorageState(
      JSON.stringify({
        cookies: [cookie({ name: 'a' }), { value: 'no name' }],
        origins: [
          { origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }, { value: 'skip' }] },
          { origin: 'not-a-url', localStorage: [] }
        ]
      })
    )
    expect(bundle.cookies.map((c) => c.name)).toEqual(['a'])
    expect(bundle.origins).toHaveLength(1)
    expect(bundle.origins[0].localStorage).toEqual([{ name: 'k', value: 'v' }])
    expect(issues).toHaveLength(2)
  })

  it('导出→解析往返保留 localStorage 与 sameSite', () => {
    const bundle = { cookies: [cookie({ sameSite: 'Strict' })], origins: [{ origin: 'https://a.test', localStorage: [{ name: 'x', value: '1' }] }] }
    const { bundle: back, issues } = parseStorageState(toStorageState(bundle))
    expect(issues).toEqual([])
    expect(back.cookies[0].sameSite).toBe('Strict')
    expect(back.origins[0].localStorage[0].value).toBe('1')
  })

  it('非法 JSON 抛错而不是静默返回空', () => {
    expect(() => parseStorageState('{oops')).toThrow(/不是合法 JSON/)
  })
})

describe('格式识别与去重', () => {
  it('以 { 开头判定为 storageState，否则 Netscape', () => {
    expect(detectFormat('  {"cookies":[]}')).toBe('playwright')
    expect(detectFormat('example.com\tTRUE\t/\t1\tFALSE\ta\tb')).toBe('netscape')
  })

  it('auto 模式下 parseCookies 自动选择解析器', () => {
    const asNetscape = parseCookies(toNetscape([cookie()]), 'auto')
    expect(asNetscape.format).toBe('netscape')
    expect(asNetscape.bundle.cookies).toHaveLength(1)
    const asState = parseCookies(toStorageState({ cookies: [cookie()], origins: [] }), 'auto')
    expect(asState.format).toBe('playwright')
  })

  it('同 domain+path+name 以导入侧为准', () => {
    const merged = mergeCookies([cookie({ value: 'old' })], [cookie({ value: 'new' })])
    expect(merged).toHaveLength(1)
    expect(merged[0].value).toBe('new')
    // 路径不同视为不同 cookie
    expect(dedupeCookies([cookie({ path: '/a' }), cookie({ path: '/b' })])).toHaveLength(2)
  })

  it('normalizeCookie 收敛缺省值：path=/、sameSite=Lax、非法过期时间=-1', () => {
    const c = normalizeCookie({ name: 'x', value: '1', domain: 'a.test', expires: 'bogus', sameSite: 'none' })
    expect(c.path).toBe('/')
    expect(c.expires).toBe(-1)
    expect(c.sameSite).toBe('None')
    expect(() => normalizeCookie({ value: '1' })).toThrow(/缺少 name/)
    expect(() => normalizeCookie({ name: 'x' })).toThrow(/缺少 domain/)
  })

  it('sameSite 缺省按 Lax（Chrome 默认），避免跨站被静默丢弃', () => {
    expect(normalizeSameSite(undefined)).toBe('Lax')
    expect(normalizeSameSite('strict')).toBe('Strict')
  })

  it('导出文件名安全化，避免路径分隔符注入', () => {
    expect(bundleFilename('../../etc/passwd', 'netscape', 1)).toBe('.._.._etc_passwd-cookies-1.txt')
    expect(bundleFilename('店铺 A', 'playwright', 2)).toBe('_A-storage-state-2.json')
  })
})