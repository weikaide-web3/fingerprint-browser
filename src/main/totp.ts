import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * TOTP（RFC 6238）/ HOTP（RFC 4226）实现。
 *
 * 为什么要自己写而不是装包：账号 2FA 是长期存下来的机密，
 * 依赖外部包意味着多一个供应链面；而且这里只需要 HMAC-SHA1 + 动态截断，
 * 用 RFC 官方测试向量就能完全覆盖。
 *
 * 注意：Google / X 的验证器都接受 ±1 个时间窗的偏移（时钟漂移很常见），
 * 所以 verify 默认检查 t-1 / t / t+1。
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Base32 解码（RFC 4648）。空格与连字符忽略，大小写不敏感，padding 可省。 */
export function base32Decode(input: string): Buffer {
  const clean = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
  if (!clean) return Buffer.alloc(0)
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error(`Base32 含非法字符：${ch}（密钥应只含 A-Z 与 2-7）`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function isValidBase32(input: string): boolean {
  try {
    return base32Decode(input).length > 0
  } catch {
    return false
  }
}

/** 把密钥规范化成展示/存储形式：大写、去空格 */
export function normalizeTotpSecret(input: string): string {
  return String(input ?? '').toUpperCase().replace(/[\s-]/g, '')
}

/** 从 otpauth:// URI 里取密钥（验证器二维码就是这个格式） */
export function parseOtpauthUri(uri: string): { secret: string; label: string; issuer: string; digits: number; period: number } | null {
  try {
    const u = new URL(uri)
    if (u.protocol !== 'otpauth:') return null
    const secret = u.searchParams.get('secret')
    if (!secret) return null
    const label = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
    return {
      secret: normalizeTotpSecret(secret),
      label,
      issuer: u.searchParams.get('issuer') ?? label.split(':')[0] ?? '',
      digits: Number(u.searchParams.get('digits') ?? 6),
      period: Number(u.searchParams.get('period') ?? 30)
    }
  } catch {
    return null
  }
}

/** HOTP（RFC 4226）：计数器 -> 定长数字码 */
export function hotp(secretBytes: Buffer, counter: number, digits = 6): string {
  // 计数器必须是 8 字节大端；用 writeBigUInt64BE 而不是 writeUInt32BE，
  // 否则 2000-01-01 之后的 epoch（>2^32）会溢出，RFC 的长时标测试向量就会失败。
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secretBytes).update(buf).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const bin =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]
  const mod = 10 ** digits
  return String(bin % mod).padStart(digits, '0')
}

export interface TotpOptions {
  digits?: number
  periodSeconds?: number
  /** 指定时刻（毫秒），默认当前时间 */
  at?: number
}

export interface TotpResult {
  code: string
  digits: number
  periodSeconds: number
  /** 当前窗口剩余秒数：UI 用它画倒计时 */
  remainingSeconds: number
  counter: number
}

export function totp(secret: string, opts: TotpOptions = {}): TotpResult {
  const digits = opts.digits && opts.digits >= 6 && opts.digits <= 8 ? opts.digits : 6
  const period = opts.periodSeconds && opts.periodSeconds >= 5 ? opts.periodSeconds : 30
  const at = opts.at ?? Date.now()
  const counter = Math.floor(Math.floor(at / 1000) / period)
  const code = hotp(base32Decode(secret), counter, digits)
  const intoWindow = Math.floor(at / 1000) % period
  return { code, digits, periodSeconds: period, remainingSeconds: period - intoWindow, counter }
}

/** 当前码 + 前后各 window 个窗口，用来容忍客户端与服务器的时钟漂移 */
export function totpWindow(secret: string, opts: TotpOptions = {}, window = 1): string[] {
  const digits = opts.digits && opts.digits >= 6 && opts.digits <= 8 ? opts.digits : 6
  const period = opts.periodSeconds && opts.periodSeconds >= 5 ? opts.periodSeconds : 30
  const at = opts.at ?? Date.now()
  const bytes = base32Decode(secret)
  const counter = Math.floor(Math.floor(at / 1000) / period)
  const out: string[] = []
  for (let i = -window; i <= window; i += 1) out.push(hotp(bytes, counter + i, digits))
  return out
}

export function verifyTotp(secret: string, code: string, opts: TotpOptions = {}, window = 1): boolean {
  const want = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{6,8}$/.test(want)) return false
  const candidates = totpWindow(secret, opts, window)
  // 定长比较：避免通过响应时间猜码
  const buf = Buffer.from(want)
  return candidates.some((c) => buf.length === c.length && timingSafeEqual(Buffer.from(c), buf))
}