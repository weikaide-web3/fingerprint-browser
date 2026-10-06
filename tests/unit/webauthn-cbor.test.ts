import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { parseAttestationObject, parseAuthData, rpIdHashHex, b64urlToB64, b64, describeFlags, FLAG } from '../../src/main/webauthn/cbor'

/**
 * WebAuthn CBOR 解析单测。
 *
 * 用一个自建的极简 CBOR 编码器构造 attestationObject —— 编码器与解析器互相独立，
 * 因此这组断言检验的是「解析器能否还原我们已知的事实」，而不是自证正确。
 */

function cborHead(major: number, ai: number): number[] {
  return [(major << 5) | ai]
}

function cborInt(n: number): number[] {
  if (n >= 0) {
    if (n < 24) return cborHead(0, n)
    if (n < 256) return [...cborHead(0, 24), n]
    if (n < 65536) return [...cborHead(0, 25), (n >> 8) & 255, n & 255]
    return [...cborHead(0, 26), (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const v = -1 - n
  if (v < 24) return cborHead(1, v)
  if (v < 256) return [...cborHead(1, 24), v]
  return [...cborHead(1, 25), (v >> 8) & 255, v & 255]
}

function cborBytes(b: Uint8Array | number[]): number[] {
  const arr = Array.from(b)
  const n = arr.length
  if (n < 24) return [...cborHead(2, n), ...arr]
  if (n < 256) return [...cborHead(2, 24), n, ...arr]
  return [...cborHead(2, 25), (n >> 8) & 255, n & 255, ...arr]
}

function cborText(s: string): number[] {
  const arr = Array.from(new TextEncoder().encode(s))
  const n = arr.length
  if (n < 24) return [...cborHead(3, n), ...arr]
  if (n < 256) return [...cborHead(3, 24), n, ...arr]
  return [...cborHead(3, 25), (n >> 8) & 255, n & 255, ...arr]
}

function cborMap(entries: [number[], number[]][]): number[] {
  const out = cborHead(5, entries.length)
  for (const [k, v] of entries) out.push(...k, ...v)
  return out
}

const AAGUID = '00000000-0000-4000-a000-000050000000' // Apple 平台认证器
const CRED_ID = 'credential-id-abc'
const RP_ID = 'accounts.google.com'

function aaguidBytes(uuid: string): Uint8Array {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/** ES256 COSE key：{1:2, 3:-7, -1:1, -2:x, -3:y} */
function coseEs256(x: Uint8Array, y: Uint8Array): number[] {
  const neg = (n: number): number[] => cborInt(n)
  return cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [neg(-1), cborInt(1)],
    [neg(-2), cborBytes(x)],
    [neg(-3), cborBytes(y)]
  ])
}

function buildAuthData(opts: { flags: number; signCount: number; withCredential: boolean }): Uint8Array {
  const rpIdHash = createHash('sha256').update(RP_ID).digest()
  const head = Buffer.alloc(37)
  rpIdHash.copy(head, 0)
  head[32] = opts.flags
  head.writeUInt32BE(opts.signCount, 33)
  if (!opts.withCredential) return head
  const cid = Buffer.from(CRED_ID, 'utf8')
  const tail = Buffer.alloc(16 + 2 + cid.length)
  Buffer.from(aaguidBytes(AAGUID)).copy(tail, 0)
  tail.writeUInt16BE(cid.length, 16)
  cid.copy(tail, 18)
  const pub = coseEs256(Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0x55))
  return new Uint8Array(Buffer.concat([head, tail, Buffer.from(pub)]))
}

function buildAttestationObject(authData: Uint8Array, fmt = 'none'): Uint8Array {
  return Uint8Array.from(
    cborMap([
      [cborText('fmt'), cborText(fmt)],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(authData)]
    ])
  )
}

describe('WebAuthn CBOR / authData 解析', () => {
  it('解析注册响应：fmt、标志位、AAGUID、credentialId、COSE 算法', () => {
    const ad = buildAuthData({ flags: FLAG.UP | FLAG.UV | FLAG.BE | FLAG.AT, signCount: 7, withCredential: true })
    const parsed = parseAttestationObject(buildAttestationObject(ad))
    expect(parsed.fmt).toBe('none')
    expect(parsed.rpIdHash).toBe(createHash('sha256').update(RP_ID).digest('hex'))
    expect(parsed.flags & FLAG.AT).toBe(FLAG.AT) // AT：带凭证数据（bit6）
    expect(parsed.flags & FLAG.UV).toBe(FLAG.UV) // UV：已通过用户验证
    expect(parsed.flags & FLAG.BE).toBe(FLAG.BE) // BE：云同步 passkey
    expect(parsed.signCount).toBe(7)
    expect(parsed.aaguid).toBe(AAGUID)
    expect(Buffer.from(parsed.credentialId!, 'base64').toString('utf8')).toBe(CRED_ID)
    expect(parsed.publicKeyAlgorithm).toBe(-7) // ES256
    expect(parsed.publicKey && parsed.publicKey.length).toBeGreaterThan(20)
  })

  it('signCount 是无符号 32 位：超过 2^31 不会变负', () => {
    const ad = buildAuthData({ flags: FLAG.UP | FLAG.AT, signCount: 0xffffffff, withCredential: true })
    const parsed = parseAttestationObject(buildAttestationObject(ad))
    expect(parsed.signCount).toBe(4294967295)
  })

  it('没有 AT 标志时不臆造凭证数据', () => {
    const ad = buildAuthData({ flags: FLAG.UP, signCount: 3, withCredential: false })
    const parsed = parseAttestationObject(buildAttestationObject(ad))
    expect(parsed.aaguid).toBeNull()
    expect(parsed.credentialId).toBeNull()
    expect(parsed.publicKey).toBeNull()
    expect(parsed.publicKeyAlgorithm).toBeNull()
  })

  it('登录断言只有 37 字节：BE 置位也不能被误当成 AT 去解析凭证', () => {
    // 回归：曾经把 AT 写成 0x08，于是带 BE 的断言被当成含凭证数据而抛「截断」，
    // 导致 signCount 永远读不到、标志位体检全部失效。
    const rpIdHash = createHash('sha256').update(RP_ID).digest()
    const ad = Buffer.alloc(37)
    rpIdHash.copy(ad, 0)
    ad[32] = FLAG.UP | FLAG.UV | FLAG.BE
    ad.writeUInt32BE(4, 33)
    const parsed = parseAuthData(new Uint8Array(ad))
    expect(parsed.signCount).toBe(4)
    expect(parsed.aaguid).toBeNull()
    expect(describeFlags(parsed.flags)).toContain('AT=0')
    expect(describeFlags(parsed.flags)).toContain('BE=1')
  })

  it('parseAuthData 与 parseAttestationObject 对同一段字节结论一致', () => {
    const ad = buildAuthData({ flags: FLAG.UP | FLAG.UV | FLAG.AT, signCount: 12, withCredential: true })
    const a = parseAuthData(ad)
    const b = parseAttestationObject(buildAttestationObject(ad))
    expect(a.aaguid).toBe(b.aaguid)
    expect(a.signCount).toBe(b.signCount)
    expect(b64(a.credentialPublicKey!)).toBe(b.publicKey)
  })

  it('备份标志位 BE/BS 能被读出来（站点据此判断是否换了设备类型）', () => {
    const ad = buildAuthData({ flags: FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS | FLAG.AT, signCount: 1, withCredential: true })
    const a = parseAuthData(ad)
    expect(Boolean(a.flags & FLAG.BE)).toBe(true) // backupEligibility = bit3
    expect(Boolean(a.flags & FLAG.BS)).toBe(true) // backupState = bit4
    expect(describeFlags(a.flags)).toBe('UP=1 UV=1 AT=1 BS=1 BE=1')
  })

  it('截断的数据抛错而不是返回半截结果', () => {
    expect(() => parseAuthData(new Uint8Array(20))).toThrow(/长度不足/)
    const ad = buildAuthData({ flags: FLAG.UP | FLAG.AT, signCount: 1, withCredential: true })
    expect(() => parseAuthData(ad.slice(0, 60))).toThrow(/截断/)
    expect(() => parseAttestationObject(new Uint8Array([0xa0, 0xff]))).toThrow()
  })

  it('rpIdHash 与站点域名对应，可用于校验凭证归属', () => {
    expect(rpIdHashHex(RP_ID)).toBe(createHash('sha256').update(RP_ID).digest('hex'))
    expect(rpIdHashHex('twitter.com')).not.toBe(rpIdHashHex('x.com'))
  })

  it('base64url 归一化：内核回传的 rawId 常是 url-safe 变体', () => {
    expect(b64urlToB64('aGVsbG8')).toBe('aGVsbG8=')
    expect(b64urlToB64('-_8_')).toBe('+/8/')
    expect(Buffer.from(b64urlToB64('aGVsbG8'), 'base64').toString()).toBe('hello')
  })
})