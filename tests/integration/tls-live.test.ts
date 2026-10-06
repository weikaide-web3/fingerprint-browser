import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, ensureDir } from '../../src/main/paths'
import { initDatabase, closeDatabase } from '../../src/main/db'
import { createProfile } from '../../src/main/db/repositories/profiles'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { resolveChromiumExecutable, detectKernelVersion } from '../../src/main/browser/executable'
import { stopAllProfiles } from '../../src/main/browser/launcher'
import { probeTls, promoteBaseline, baselines, history } from '../../src/main/services/tls'
import { parseClientHello, fingerprintHello, isGrease } from '../../src/main/tls/hello'
import { h2FromRemoteSettings } from '../../src/main/tls/http2'
import { chromeMajor } from '../../src/main/tls/baseline'
import { setTypedSetting } from '../../src/main/settings/defs'
import type { Profile } from '@shared/types'

/**
 * P2-1 验收：TLS ClientHello（JA3/JA4）与 HTTP/2 SETTINGS 必须在真实内核上采到，
 * 并且与「同版本内核基线」可比对。
 *
 * 这一层 JS 完全读不到，只能被动观测 —— 所以测试要证明的是：
 * 观测链路真的能拿到字节、解析结果符合 Chrome 特征、且跨进程稳定。
 */

let tmpDir = ''
let profile: Profile

/**
 * JA4 第一段的真实形状：t + 版本(13/12/…) + SNI 标记(有 SNI='d'，无='i')
 * + 套件数(十进制 2 位) + 扩展数(十进制 2 位) + ALPN 标记，
 * 之后是两段 12 位 hex（套件哈希 / 扩展哈希）。
 * 例：Chrome 124 的公开值是 t13d1516h2_8daaf6152771_86b7aa481d09。
 */
const JA4_RE = /^t(13|12|11|10|s3|s2|s1|s0|00)[di0-9]\d{4}[a-z0-9]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-tls-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  initDatabase(path.join(tmpDir, 'app.db'))
  const exe = resolveChromiumExecutable()
  const fp = generateFingerprint({
    seed: 'tls-live-seed',
    os: 'macOS',
    locale: 'en-US',
    timezone: 'Asia/Tokyo',
    kernelVersion: detectKernelVersion(exe) ?? '132.0.6834.110'
  })
  profile = createProfile({ name: 'tls-live', fingerprint: fp, sessionPolicy: 'keep' })
})

afterAll(async () => {
  await stopAllProfiles().catch(() => undefined)
  closeDatabase()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('TLS / HTTP2 指纹（真实内核被动观测）', () => {
  it('本机源服务器链路：ClientHello 与 H2 SETTINGS 都能采到，且符合 Chrome 特征', async () => {
    const res = await probeTls(profile.id, { headless: true })
    expect(res.error, res.error ?? '').toBeNull()

    const tapObs = res.observations.filter((o) => o.via === 'tap')
    expect(tapObs.length, 'tap 没有观测到任何 ClientHello').toBeGreaterThan(0)
    const primary = tapObs[0]

    // 解析本身要成立：JA3 是 32 位 hex；JA4 = t<版本><SNI><套件数><扩展数><ALPN>_<套件哈希>_<扩展哈希>
    expect(primary.tls.ja3).toMatch(/^[0-9a-f]{32}$/)
    expect(primary.tls.ja4).toMatch(JA4_RE)
    // JA4r 是「未哈希」的 JA4：同样的前缀 + 三段逗号分隔的 hex 列表
    const raw = primary.tls.ja4r.split('_')
    expect(raw[0]).toBe(primary.tls.ja4.split('_')[0])
    expect(raw.length).toBeGreaterThanOrEqual(3)
    for (const seg of raw.slice(1)) expect(seg).toMatch(/^([0-9a-f]{4}(,[0-9a-f]{4})*)$/)
    // 哈希段与原文段不能相同，否则说明哈希那一步被跳过了
    expect(primary.tls.ja4r).not.toBe(primary.tls.ja4)
    expect(primary.tls.versionLabel).toBe('13')
    expect(primary.tls.cipherCount).toBeGreaterThan(5)
    expect(primary.tls.extensionCount).toBeGreaterThan(8)
    // 真实 Chrome 一定带 GREASE；自己拼 ClientHello 的工具通常不带
    expect(primary.tls.greaseCount).toBeGreaterThan(0)
    expect(primary.tls.alpn).toContain('h2')

    // H2 SETTINGS 在 TLS 之内，只有我们自己当服务器才读得到
    const withH2 = res.observations.find((o) => o.h2)
    expect(withH2, '没有读到 HTTP/2 SETTINGS').toBeTruthy()
    const h2 = withH2!.h2!
    expect(h2.preface).toBe(true)
    expect(h2.settings.length).toBeGreaterThan(0)
    // Chrome 的 SETTINGS 里 enablePush(0x02) 必为 0；为 1 的是老 Firefox / 工具
    const push = h2.settings.find((s) => s.id === 0x02)
    if (push) expect(push.value, 'Chrome 不会开启 HTTP/2 push').toBe(0)
    expect(h2.fp).toMatch(/^S=.*;P=.*;A=.*;W=/)

    const bad = res.items.filter((i) => i.status === 'mismatch').map((i) => `${i.key} 期望=${i.expected} 实测=${i.actual}`)
    // eslint-disable-next-line no-console
    console.log('[tls] JA4=', primary.tls.ja4, 'h2fp=', h2.fp, 'score=', res.score, 'mismatch=', bad)
    expect(bad).toEqual([])
    expect(res.score).toBe(100)

    // 请求头顺序：内核在 http/1.1 上实际发出的头部必须被读到并符合 Chrome 形状
    expect(res.request, '没有读到内核实际发出的请求头').toBeTruthy()
    const req = res.request!
    expect(req.headers[0].name).toBe('host')
    const headerItems = res.items.filter((i) => i.key.startsWith('http.'))
    expect(headerItems.length, '请求头分析没有并入报告').toBeGreaterThan(8)
    for (const key of [
      'http.order.hostFirst',
      'http.order.uaBeforeAccept',
      'http.order.secFetchGroup',
      'http.order.encodingAfterSecFetch',
      'http.order.languageAfterEncoding',
      'http.order.cookieLast',
      'http.order.chBeforeUa',
      'http.nameCase',
      'http.noProxyHeaders',
      'http.noAutomationHeaders',
      'http.connectionHeader',
      'http.uaMatchesProfile',
      'http.acceptLanguageMatchesProfile',
      'http.secChUa',
      'http.secChUaPlatform'
    ]) {
      const item = headerItems.find((i) => i.key === key)
      expect(item, `缺少请求头比对项 ${key}`).toBeTruthy()
      expect(item!.status, `${key}: 期望=${item!.expected} 实测=${item!.actual}`).toBe('ok')
    }
    // Chrome 的线上大小写：sec-ch-ua* 全小写、Sec-Fetch-* Title-Case
    const rawNames = req.headers.map((h) => h.raw)
    expect(rawNames).toContain('sec-ch-ua')
    expect(rawNames).toContain('Sec-Fetch-Site')
  }, 180000)

  it('第二次观测命中基线且完全一致（同一内核跨进程稳定）', async () => {
    const base = promoteBaseline(profile.id)
    // t + 协议位 + 版本(2) + SNI 位(d/i) + 套件数(2) + 扩展数(2) + ALPN(2)
    expect(base.ja4).toMatch(/^t[0-9a-z]{2}[di]\d{4}[0-9a-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/)
    expect(base.samples).toBeGreaterThan(0)
    expect(baselines().some((b) => b.kernelVersion === base.kernelVersion)).toBe(true)

    const again = await probeTls(profile.id, { headless: true })
    expect(again.error).toBeNull()
    expect(again.baseline, '第二次检测没有命中基线').toBeTruthy()
    const tapObs = again.observations.find((o) => o.via === 'tap')!
    expect(tapObs.tls.ja4, '同一内核两次观测 JA4 不同 → 形状不稳定').toBe(base.ja4)
    for (const key of ['tls.ja4', 'tls.ja3', 'tls.ciphers', 'tls.extensions']) {
      const item = again.items.find((i) => i.key === key)
      expect(item, `缺少比对项 ${key}`).toBeTruthy()
      expect(item!.status, `${key}: 期望=${item!.expected} 实测=${item!.actual}`).toBe('ok')
    }
    expect(history(profile.id).length).toBeGreaterThanOrEqual(3)
  }, 180000)

  it('UA 声明版本与内核实测版本不一致时会被标红（TLS 形状出卖内核版本）', async () => {
    // 用设置覆盖内核版本，模拟「UA 写 120 但内核是 999」这种最常见的自伤
    setTypedSetting('kernelVersionCache', '999.0.4844.0')
    try {
      const res = await probeTls(profile.id, { headless: true })
      const item = res.items.find((i) => i.key === 'check.tlsKernelCoherence')
      expect(item).toBeTruthy()
      expect(item!.status).toBe('mismatch')
      expect(item!.actual).toBe('999')
      expect(chromeMajor('999.0.4844.0')).toBe(999)
    } finally {
      setTypedSetting('kernelVersionCache', '')
    }
  }, 180000)

  it('tap 是纯被动观测：不改写任何字节，且去 GREASE 后的 JA3 跨连接稳定', async () => {
    // 同一次探测里，tap 回调拿到的 ja3String 必须与入库的观测完全一致
    const seen: string[] = []
    const res = await probeTls(profile.id, { headless: true, onHello: (o) => seen.push(o.fp.ja3String) })
    const first = res.observations.find((o) => o.via === 'tap')!
    // JA3 原文是「版本 + 套件 + 扩展 + 曲线 + 点格式」全部用逗号连成一串，
    // 所以逗号数量必然明显多于套件数与扩展数之和 —— 用它确认没有只截其中一段。
    const parts = first.tls.ja3String.split(',')
    expect(parts.length).toBeGreaterThan(first.tls.cipherCount + first.tls.extensionCount)
    // 被动观测必须原样保留 GREASE：真实 Chrome 一定带，被剔掉就说明中间有人改写了字节。
    // 注意 JA3 里的数字是十进制（GREASE 0x1a1a -> 6682），不能按 hex 匹配。
    expect(first.tls.greaseCount, '真实 Chrome 的 ClientHello 一定带 GREASE').toBeGreaterThan(0)
    const greaseInWire = parts.slice(1).some((p) => p !== '' && isGrease(Number(p)))
    expect(greaseInWire, 'JA3 原文里没有 GREASE 项 → ClientHello 被改写过').toBe(true)
    // 去 GREASE 的 JA3 与原始 JA3 必须不同（GREASE 确实在原文里）
    expect(first.tls.ja3Stable).toMatch(/^[0-9a-f]{32}$/)
    expect(first.tls.ja3Stable, 'GREASE 没被剔掉，去 GREASE 的 JA3 应与原始值不同').not.toBe(first.tls.ja3)
    // 回调必须真的收到过握手，且与入库的那条一字不差
    expect(seen.length, 'tap 没有回调任何 ClientHello').toBeGreaterThan(0)
    expect(seen.some((s) => s === first.tls.ja3String), 'tap 回调与入库观测不一致 → 中间改写过字节').toBe(true)

    // Chrome 会按连接随机打乱扩展顺序与套件顺序（实测：同一内核同一进程内
    // 21 条连接 21 种原始 JA3），所以「去 GREASE 但保留顺序」的 JA3 本来就不该
    // 稳定 —— 这正是 JA4 要排序的原因。
    //
    // 但「同一次探测内全局只应有 1 种 JA4」也是错的：探测会连两个本机源服务器，
    // 一个 ALPN=h2、一个 ALPN=http/1.1（后者专门用来读内核的请求头顺序），
    // ALPN 不同 → JA4 前缀不同，这是内核的真实差异，不是观测噪声。
    // 因此正确的不变量是：同一个 host（= 同一 ALPN）内归一化结果必须完全一致，
    // 且归一化必须把抖动收敛掉（种类数明显少于原始 JA3）。
    const taps = res.observations.filter((o) => o.via === 'tap')
    const raws = new Set(taps.map((o) => o.tls.ja3))
    const stables = new Set(taps.map((o) => o.tls.ja3Stable))
    const sorted = new Set(taps.map((o) => o.tls.ja3Sorted))
    const ja4s = new Set(taps.map((o) => o.tls.ja4))
    // eslint-disable-next-line no-console
    console.log(
      '[tls] 同一次探测内：原始 JA3 种类=',
      raws.size,
      '去 GREASE 保序=',
      stables.size,
      '去 GREASE 排序=',
      sorted.size,
      'JA4 种类=',
      ja4s.size
    )
    expect(taps.length, '至少要有两条连接才能证明归一化有效').toBeGreaterThan(1)
    // 归一化必须收敛：排序后的种类数必须远少于原始种类数
    expect(sorted.size, '排序归一化没有收敛抖动').toBeLessThan(raws.size)
    expect(stables.size, '去 GREASE 保序反而更抖').toBeGreaterThanOrEqual(sorted.size)

    // 按 host 分组：同一 host（同一 ALPN）内，去 GREASE 排序后的 JA3 与 JA4 必须一字不差
    const byHost = new Map<string, typeof taps>()
    for (const o of taps) {
      const list = byHost.get(o.host) ?? []
      list.push(o)
      byHost.set(o.host, list)
    }
    for (const [host, list] of byHost) {
      if (list.length < 2) continue
      const s = new Set(list.map((o) => o.tls.ja3Sorted))
      const j = new Set(list.map((o) => o.tls.ja4))
      expect(s.size, `${host}：同一 host 内去 GREASE 排序后的 JA3 不稳定`).toBe(1)
      expect(j.size, `${host}：同一 host 内 JA4 不稳定`).toBe(1)
    }
  }, 180000)

  it('解析器对畸形输入不崩（一个坏包不能让整条观测链路挂掉）', () => {
    expect(() => parseClientHello(Buffer.from([0x16, 0x03, 0x01]))).toThrow()
    expect(() => parseClientHello(Buffer.alloc(0))).toThrow()
    const h2 = h2FromRemoteSettings({ headerTableSize: 65536, enablePush: undefined })
    expect(h2.settings.map((s) => s.id)).toEqual([0x1])
    expect(h2.fp).toBe('S=1:65536;P=;A=4;W=')
    expect(() => fingerprintHello(parseClientHello(sampleHello()))).not.toThrow()
  })
})

/** 一段最小可用的 ClientHello（TLS record + 两个密码套件 + SNI + 一个未知扩展） */
function sampleHello(): Buffer {
  const cipherSuites = Buffer.from([0x13, 0x01, 0x13, 0x03])
  const sni = Buffer.from('example.com', 'latin1')
  const sniValue = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from([(sni.length >> 8) & 0xff, sni.length & 0xff]),
    sni
  ])
  const sniExt = Buffer.concat([
    Buffer.from([0x00, 0x00]),
    Buffer.from([(sniValue.length + 2 >> 8) & 0xff, (sniValue.length + 2) & 0xff]),
    Buffer.from([(sniValue.length >> 8) & 0xff, sniValue.length & 0xff]),
    sniValue
  ])
  const unknown = Buffer.from([0xff, 0xff, 0x00, 0x00])
  const extensions = Buffer.concat([sniExt, unknown])
  const hello = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32),
    Buffer.from([0x00]),
    Buffer.from([(cipherSuites.length >> 8) & 0xff, cipherSuites.length & 0xff]),
    cipherSuites,
    Buffer.from([0x00]),
    Buffer.from([(extensions.length >> 8) & 0xff, extensions.length & 0xff]),
    extensions
  ])
  // 握手头是 1 字节类型 + 3 字节长度（不是 2 字节），写错会让解析器读到错位的长度
  const body = Buffer.concat([
    Buffer.from([0x01, (hello.length >> 16) & 0xff, (hello.length >> 8) & 0xff, hello.length & 0xff]),
    hello
  ])
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01, (body.length >> 8) & 0xff, body.length & 0xff]), body])
}