import { describe, it, expect } from 'vitest'
import {
  base32Decode,
  isValidBase32,
  normalizeTotpSecret,
  parseOtpauthUri,
  hotp,
  totp,
  totpWindow,
  verifyTotp
} from '../../src/main/totp'

/**
 * TOTP / HOTP 用 RFC 4226 与 RFC 6238 的官方测试向量验证。
 *
 * 自己实现 2FA 就必须自己证明它正确 —— 一个差一位的验证码实现
 * 会让用户在登录页反复失败，而错误信息看起来像「账号有问题」。
 */

// RFC 4226 附录 D：密钥 "12345678901234567890"
const RFC4226_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const RFC4226_CODES = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']

describe('Base32', () => {
  it('RFC 4226 密钥解码为 20 字节 ASCII', () => {
    expect(base32Decode(RFC4226_SECRET)).toEqual(Buffer.from('12345678901234567890', 'ascii'))
  })

  it('忽略空格、连字符、大小写与 padding', () => {
    const bare = base32Decode('JBSWY3DP')
    expect(base32Decode('jbsw y3dp')).toEqual(bare)
    expect(base32Decode('JBSW-Y3DP=')).toEqual(bare)
  })

  it('非法字符报错而不是静默截断', () => {
    expect(() => base32Decode('ABC!')).toThrow(/非法字符/)
    expect(isValidBase32('ABC!')).toBe(false)
    expect(isValidBase32('JBSWY3DP')).toBe(true)
    expect(isValidBase32('')).toBe(false)
  })

  it('normalize 统一成大写无空格', () => {
    expect(normalizeTotpSecret(' jbsw-y3dp ')).toBe('JBSWY3DP')
  })
})

describe('otpauth URI', () => {
  it('解析验证器二维码格式', () => {
    const r = parseOtpauthUri(
      'otpauth://totp/Google%3Aalice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Google&digits=6&period=30'
    )
    expect(r).not.toBeNull()
    expect(r!.secret).toBe('JBSWY3DPEHPK3PXP')
    expect(r!.issuer).toBe('Google')
    expect(r!.label).toBe('Google:alice@example.com')
    expect(r!.digits).toBe(6)
    expect(r!.period).toBe(30)
  })

  it('非 otpauth 或缺 secret 时返回 null', () => {
    expect(parseOtpauthUri('https://example.com')).toBeNull()
    expect(parseOtpauthUri('otpauth://totp/x')).toBeNull()
    expect(parseOtpauthUri('not a url')).toBeNull()
  })
})

describe('HOTP（RFC 4226）', () => {
  it('计数器 0-9 与官方向量完全一致', () => {
    const secret = base32Decode(RFC4226_SECRET)
    RFC4226_CODES.forEach((code, counter) => {
      expect(hotp(secret, counter), `counter=${counter}`).toBe(code)
    })
  })

  it('大计数器不溢出（epoch 时间戳 > 2^32）', () => {
    const secret = base32Decode(RFC4226_SECRET)
    // RFC 6238 的 T0=59 向量：counter=1 => 94287082（8 位）
    expect(hotp(secret, 1, 8)).toBe('94287082')
    const big = hotp(secret, 2 ** 40, 6)
    expect(big).toMatch(/^\d{6}$/)
  })

  it('支持 6-8 位', () => {
    const secret = base32Decode(RFC4226_SECRET)
    expect(hotp(secret, 0, 6)).toBe('755224')
    expect(hotp(secret, 0, 7)).toMatch(/^\d{7}$/)
    expect(hotp(secret, 0, 8)).toMatch(/^\d{8}$/)
  })
})

describe('TOTP（RFC 6238）', () => {
  // RFC 6238 附录 B：8 位码，T0 = 1970-01-01T00:00:00Z
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ]

  it('官方时间向量全部命中', () => {
    for (const [unixSeconds, code] of vectors) {
      const r = totp(RFC4226_SECRET, { digits: 8, at: unixSeconds * 1000 })
      expect(r.code, `t=${unixSeconds}`).toBe(code)
    }
  })

  it('窗口剩余秒数正确（用于 UI 倒计时）', () => {
    const r = totp(RFC4226_SECRET, { at: 1_700_000_000_000 })
    expect(r.periodSeconds).toBe(30)
    // 1_700_000_000 % 30 = 20 => 剩 10 秒
    expect(1_700_000_000 % 30).toBe(20)
    expect(r.remainingSeconds).toBe(10)
  })

  it('同一 30 秒窗口内码不变，跨窗口会变', () => {
    const base = 1_700_000_000_000
    const a = totp(RFC4226_SECRET, { at: base })
    const b = totp(RFC4226_SECRET, { at: base + 1000 })
    const c = totp(RFC4226_SECRET, { at: base + 30_000 })
    expect(a.code).toBe(b.code)
    expect(a.code).not.toBe(c.code)
  })

  it('窗口容差覆盖前后一个周期（时钟漂移）', () => {
    const at = 1_700_000_000_000
    const now = totp(RFC4226_SECRET, { at }).code
    const prev = totp(RFC4226_SECRET, { at: at - 30_000 }).code
    const next = totp(RFC4226_SECRET, { at: at + 30_000 }).code
    const codes = totpWindow(RFC4226_SECRET, { at })
    expect(codes).toHaveLength(3)
    expect(codes).toContain(now)
    expect(codes).toContain(prev)
    expect(codes).toContain(next)
  })

  it('verify 接受 ±1 窗口，拒绝窗口外的码', () => {
    const at = 1_700_000_000_000
    expect(verifyTotp(RFC4226_SECRET, totp(RFC4226_SECRET, { at }).code, { at })).toBe(true)
    expect(verifyTotp(RFC4226_SECRET, totp(RFC4226_SECRET, { at: at - 30_000 }).code, { at })).toBe(true)
    expect(verifyTotp(RFC4226_SECRET, totp(RFC4226_SECRET, { at: at - 90_000 }).code, { at })).toBe(false)
  })

  it('verify 忽略空格，拒绝格式非法的输入', () => {
    const at = 1_700_000_000_000
    const code = totp(RFC4226_SECRET, { at }).code
    expect(verifyTotp(RFC4226_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { at })).toBe(true)
    expect(verifyTotp(RFC4226_SECRET, '12345', { at })).toBe(false)
    expect(verifyTotp(RFC4226_SECRET, 'abcdef', { at })).toBe(false)
    expect(verifyTotp(RFC4226_SECRET, '', { at })).toBe(false)
  })

  it('密钥错误时不会碰巧命中', () => {
    const at = 1_700_000_000_000
    const code = totp('JBSWY3DPEHPK3PXP', { at }).code
    expect(verifyTotp(RFC4226_SECRET, code, { at })).toBe(false)
  })
})