/**
 * 解析 WebAuthn attestationObject（CBOR）与 authenticatorData。
 *
 * 为什么需要：CDP 的 getCredentials 只回传私钥与 credentialId，
 * 不回传 COSE 公钥与 AAGUID —— 而这两项正是「这台设备上的 passkey 长什么样」的关键信息，
 * 必须从注册响应的 attestationObject 里自己解析出来才能持久化与比对。
 *
 * 只实现 WebAuthn 实际会用到的 CBOR 子集（map / bstr / uint / bool / null / tag），
 * 不引入第三方依赖。
 */

export interface ParsedAttestation {
  fmt: string
  rpIdHash: string
  flags: number
  signCount: number
  /** 有 AT 标志时才有；fmt=none 时内核给的是随机值 */
  aaguid: string | null
  credentialId: string | null
  /** COSE 公钥的 base64（用于展示与跨环境比对） */
  publicKey: string | null
  publicKeyAlgorithm: number | null
}

export function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return Buffer.from(s, 'binary').toString('base64')
}

/**
 * authenticatorData 的 flags 位（WebAuthn Level 2 §6.1，MSB→LSB）：
 *
 *   0x80 RFU | 0x40 AT | 0x20 RFU | 0x10 BS | 0x08 BE | 0x04 UV | 0x02 RFU | 0x01 UP
 *
 * 位序很容易写错（我第一版就把 AT 写成了 0x08）。实测证据：虚拟认证器开了
 * defaultBackupEligibility 后，**登录断言**的 authData 里 0x08 恒为 1 ——
 * 而断言永远不含 attested credential data，所以 0x08 只可能是 BE，不可能是 AT。
 *
 * 站点会按这几位判断「这是不是真实设备、有没有做用户验证、是不是云同步 passkey」，
 * 所以虚拟认证器必须给出与 profile 声明一致的组合，否则注册能过、登录会被降级。
 */
export const FLAG = {
  UP: 0x01, // user present
  UV: 0x04, // user verified（Touch ID / Windows Hello 必须为 1）
  BE: 0x08, // backup eligibility（云同步 passkey 为 1）
  BS: 0x10, // backup state（当前已备份）
  AT: 0x40 // attested credential data included（只有注册响应里才有）
} as const

/** 把 flags 拆成可读文本，用于日志与界面 */
export function describeFlags(flags: number): string {
  const on = (f: number): string => (flags & f ? '1' : '0')
  return `UP=${on(FLAG.UP)} UV=${on(FLAG.UV)} AT=${on(FLAG.AT)} BS=${on(FLAG.BS)} BE=${on(FLAG.BE)}`
}

export function b64urlToB64(v: string): string {
  const s = v.replace(/-/g, '+').replace(/_/g, '/')
  return s + '='.repeat((4 - (s.length % 4)) % 4)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function fmtAaguid(bytes: Uint8Array): string {
  const h = hex(bytes)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

class Reader {
  private pos = 0
  constructor(private buf: Uint8Array) {}

  private byte(): number {
    if (this.pos >= this.buf.length) throw new Error('CBOR 截断')
    return this.buf[this.pos++]
  }

  private head(): [number, number, number] {
    const ib = this.byte()
    const major = ib >> 5
    const ai = ib & 0x1f
    if (ai < 24) return [major, ai, ai]
    if (ai === 24) return [major, ai, this.byte()]
    if (ai === 25) return [major, ai, (this.byte() << 8) | this.byte()]
    if (ai === 26) return [major, ai, ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0]
    if (ai === 27) {
      let v = 0
      for (let i = 0; i < 8; i += 1) v = v * 256 + this.byte()
      return [major, ai, v]
    }
    throw new Error(`不支持的 CBOR additional info：${ai}`)
  }

  private take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('CBOR 数据截断')
    const out = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** byte string -> Uint8Array，text -> string，map -> Map */
  value(): unknown {
    const [major, ai, len] = this.head()
    switch (major) {
      case 0:
        return len
      case 1:
        return -1 - len
      case 2:
        return this.take(len)
      case 3:
        return new TextDecoder().decode(this.take(len))
      case 4: {
        const arr: unknown[] = []
        for (let i = 0; i < len; i += 1) arr.push(this.value())
        return arr
      }
      case 5: {
        const m = new Map<unknown, unknown>()
        for (let i = 0; i < len; i += 1) {
          const k = this.value()
          m.set(k, this.value())
        }
        return m
      }
      case 6:
        // tag：COSE key 可能包在 tag 24 + bstr 里，解出内层值即可
        return this.value()
      case 7:
        if (ai === 20) return false
        if (ai === 21) return true
        if (ai === 22) return null
        if (ai >= 25 && ai <= 27) {
          this.take(ai === 25 ? 2 : ai === 26 ? 4 : 8)
          return null
        }
        return null
      default:
        throw new Error(`未知 CBOR major type：${major}`)
    }
  }
}

/** authenticatorData：rpIdHash(32) | flags(1) | signCount(4) | [attested credential data] */
export function parseAuthData(ad: Uint8Array): {
  rpIdHash: string
  flags: number
  signCount: number
  aaguid: string | null
  credentialId: string | null
  credentialPublicKey: Uint8Array | null
} {
  if (ad.length < 37) throw new Error('authenticatorData 长度不足')
  const flags = ad[32]
  const signCount = ((ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36]) >>> 0
  const out = {
    rpIdHash: hex(ad.slice(0, 32)),
    flags,
    signCount,
    aaguid: null as string | null,
    credentialId: null as string | null,
    credentialPublicKey: null as Uint8Array | null
  }
  const AT = FLAG.AT
  if (!(flags & AT)) return out
  if (ad.length < 37 + 18) throw new Error('attested credential data 截断')
  out.aaguid = fmtAaguid(ad.slice(37, 53))
  const cidLen = (ad[53] << 8) | ad[54]
  if (ad.length < 55 + cidLen) throw new Error('credential id 截断')
  out.credentialId = b64(ad.slice(55, 55 + cidLen))
  // 剩下的是 COSE 公钥，原样保留字节（它本身是 CBOR map）
  out.credentialPublicKey = ad.slice(55 + cidLen)
  return out
}

export function parseAttestationObject(attestationObject: Uint8Array): ParsedAttestation {
  const root = new Reader(attestationObject).value()
  if (!(root instanceof Map)) throw new Error('attestationObject 不是 CBOR map')
  const fmt = String(root.get('fmt') ?? '')
  const authData = root.get('authData')
  if (!(authData instanceof Uint8Array)) throw new Error('attestationObject 缺少 authData')
  const ad = parseAuthData(authData)
  let alg: number | null = null
  if (ad.credentialPublicKey && ad.credentialPublicKey.length) {
    try {
      const cose = new Reader(ad.credentialPublicKey).value()
      // COSE key：label 3 = alg（-7 = ES256，-257 = RS256）
      if (cose instanceof Map && typeof cose.get(3) === 'number') alg = cose.get(3) as number
    } catch {
      /* 公钥解析失败不影响主流程 */
    }
  }
  return {
    fmt,
    rpIdHash: ad.rpIdHash,
    flags: ad.flags,
    signCount: ad.signCount,
    aaguid: ad.aaguid,
    credentialId: ad.credentialId,
    publicKey: ad.credentialPublicKey ? b64(ad.credentialPublicKey) : null,
    publicKeyAlgorithm: alg
  }
}

/** rpIdHash = SHA-256(rpId)，用于校验凭证确实属于某个站点 */
export function rpIdHashHex(rpId: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(rpId).digest('hex')
}