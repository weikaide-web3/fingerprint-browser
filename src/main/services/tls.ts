import { getProfile } from '../db/repositories/profiles'
import { buildBaseline, getBaseline, insertObservation, listObservations, listBaselines, kernelsWithoutBaseline } from '../db/repositories/tls'
import { getProxyPassword } from '../db/repositories/proxies'
import { launchProfile, stopProfile } from '../browser/launcher'
import { getSession } from '../browser/registry'
import { awaitPageInjection } from '../fingerprint/injector'
import { resolveChromiumExecutable, detectKernelVersion } from '../browser/executable'
import { startTap, sniNotApplicable, type HelloObservation } from '../tls/tap'
import { startOrigin, type OriginHandle } from '../tls/origin'
import { analyzeHeaders } from '../http/headers'
import { chromeMajor, compareTls } from '../tls/baseline'
import { decryptSecret } from '../lib/crypto'
import { typedSetting } from '../settings/defs'
import { log, logError } from '../lib/log'
import type { EchoReport, Http2Fingerprint, HttpRequestHeaders, TlsBaseline, TlsObservation, TlsProbeResult, TlsFingerprintView } from '@shared/tls'
import type { TlsFingerprint } from '../tls/hello'
import type { ProxyEndpoint } from '../proxy/checker'
import type { Profile } from '@shared/types'

/**
 * TLS / HTTP2 指纹检测服务。
 *
 * 两条观测链路，各自回答一个不同的问题：
 *
 *  A. 内核一致性：环境 → 本机 tap（无上游）→ 本机 HTTP/2 源服务器。
 *     tap 偷看 ClientHello 得到 JA3/JA4，源服务器读到 HTTP/2 SETTINGS。
 *     回答的是「这个内核本身长什么样」。
 *
 *  B. 出口链路：环境 → 本机 tap（上游 = 环境绑定的代理）→ 真实站点。
 *     回答的是「服务端实际看到的形状是什么」。
 *     A 与 B 的 JA4 不一致，就说明中间有设备在做 TLS 终结
 *     （代理 MITM、企业网关、杀软），此时出口指纹已经不是内核算的那份。
 *
 * 刻意不做的事：不改写 ClientHello。伪造的握手通常缺 GREASE、扩展顺序僵硬，
 * 比「内核版本与 UA 不一致」更容易被判定为机器人。
 */

function toView(fp: TlsFingerprint): TlsFingerprintView {
  return {
    ja3: fp.ja3,
    ja3String: fp.ja3String,
    ja3Stable: fp.ja3Stable,
    ja3StableString: fp.ja3StableString,
    ja3Sorted: fp.ja3Sorted,
    ja3SortedString: fp.ja3SortedString,
    extOrder: fp.extOrder,
    ja4: fp.ja4,
    ja4r: fp.ja4r,
    versionLabel: fp.versionLabel,
    sni: fp.sni,
    alpn: fp.alpn,
    cipherCount: fp.cipherCount,
    extensionCount: fp.extensionCount,
    greaseCount: fp.greaseCount
  }
}

function proxyEndpointOf(profile: Profile): ProxyEndpoint | null {
  const p = profile.proxy
  if (!p || profile.proxyMode !== 'bind') return null
  return {
    scheme: p.scheme,
    host: p.host,
    port: p.port,
    username: p.username,
    password: decryptSecret(getProxyPassword(p.id))
  }
}

async function navigateAndSettle(profileId: string, url: string): Promise<void> {
  const s = getSession(profileId)
  if (!s) throw new Error('内核未启动')
  const page = await s.context.newPage()
  try {
    await awaitPageInjection(page)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    // 给连接一点时间：Chrome 会并行开多条连接，观测要等到至少一条完成握手
    await page.waitForTimeout(1200)
  } finally {
    await page.close().catch(() => undefined)
  }
}

/**
 * 把源服务器读到的 HTTP/2 SETTINGS 挂到对应的 ClientHello 观测上。
 *
 * 必须按 host 匹配：一次导航会并行开多条连接（gstatic / googleapis / 目标站点），
 * 挂在「第一条没有 h2 的观测」上会把指纹贴到完全无关的连接上，
 * 于是基线比对拿的是 A 连接的 TLS + B 连接的 H2 —— 假的一致或假的矛盾。
 */
function attachH2(observations: TlsObservation[], h2: Http2Fingerprint, host: string): void {
  const twin =
    observations.find((o) => o.via === 'tap' && o.h2 === null && o.host === host) ??
    observations.find((o) => o.via === 'tap' && o.h2 === null)
  if (twin) twin.h2 = h2
}

/**
 * 选出「真的读到前置帧」的那条源服务器会话。
 *
 * 不能直接取最后一条：Chrome 对同一 host 会并行开多条连接（其中一条常被提前关闭，
 * 一个前置帧都没发），取到它就把空指纹当成实测值，H2 那一项会假性通过。
 */
function pickOriginSession<T extends { host: string; h2Source: 'raw' | 'none' }>(sessions: T[], host: string): T | null {
  return sessions.find((s) => s.h2Source === 'raw' && s.host === host) ?? sessions.find((s) => s.h2Source === 'raw') ?? null
}

export interface TlsProbeOptions {
  /** 覆盖观测目标；默认用本机 HTTP/2 源服务器（唯一能同时看到 ClientHello 与 H2 帧的目标） */
  targetUrl?: string
  /** 第三方回显服务：返回 { ja3, ja4, h2fp, httpVersion }，代表「服务端真实看到的」 */
  echoUrl?: string
  headless?: boolean
  /**
   * 每次 tap 解析出一条 ClientHello 时回调（拿到的是线上原始字节解析结果）。
   * 用途：与入库观测对账，证明 tap 是纯被动观测、没有改写任何字节。
   */
  onHello?: (o: HelloObservation) => void
}

function emptyResult(profileId: string, name: string, error: string): TlsProbeResult {
  return {
    profileId,
    name,
    at: Date.now(),
    targetUrl: '',
    kernelVersion: '',
    observations: [],
    baseline: null,
    echo: null,
    request: null,
    items: [],
    ok: 0,
    mismatch: 0,
    unknown: 0,
    score: 0,
    error
  }
}

/**
 * 在真实内核里观测一次 TLS / HTTP2 指纹。
 *
 * 关键约束：内核的 --proxy-server 在启动时就定死了，所以观测必须独占一次启动。
 * 环境正在运行时先停掉、观测完再按原配置拉回来 —— 否则用户会以为
 * 「检测把环境的代理改掉了」，那比多等几秒严重得多。
 */
export async function probeTls(profileId: string, opts: TlsProbeOptions = {}): Promise<TlsProbeResult> {
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`环境不存在：${profileId}`)

  const wasRunning = Boolean(getSession(profileId))
  if (wasRunning) {
    log('tls', `环境「${profile.name}」正在运行；TLS 观测需要独占一次启动，先关闭再恢复`)
    await stopProfile(profileId)
  }

  const observations: TlsObservation[] = []
  let origin: OriginHandle | null = null
  let h1: OriginHandle | null = null
  let tap: Awaited<ReturnType<typeof startTap>> | null = null

  try {
    const exe = resolveChromiumExecutable()
    const kernelVersion = String(typedSetting<string>('kernelVersionCache', '')) || detectKernelVersion(exe) || 'unknown'

    // 观测目标：默认本机源服务器（tap 负责把假域名解析回 127.0.0.1）。
    // tls.probeUrl 让用户换成自建/第三方目标 —— 之前这个设置项定义了但从未被读取，
    // 界面上改了没有任何效果。
    const configuredTarget = String(typedSetting<string>('tls.probeUrl', '')).trim()
    const targetOverride = opts.targetUrl ?? (configuredTarget || undefined)
    origin = targetOverride ? null : await startOrigin()
    // 第二个监听器只提供 http/1.1：用来读内核实际发出的请求头顺序与大小写
    h1 = targetOverride ? null : await startOrigin({ alpn: ['http/1.1'] })
    const targetUrl = targetOverride ?? origin?.url ?? ''
    if (!targetUrl) return emptyResult(profileId, profile.name, '无法启动本机观测服务器（openssl 不可用？），且未指定 targetUrl')

    const upstream = proxyEndpointOf(profile)
    const resolve: Record<string, string> = origin ? { [origin.host]: '127.0.0.1' } : {}

    tap = await startTap({
      upstream: upstream ?? undefined,
      resolve,
      onHello: (o) => {
        // 先给外部回调：测试用它确认 tap 看到的字节与入库观测完全一致
        try {
          opts.onHello?.(o)
        } catch (e) {
          logError('tls', 'onHello 回调异常', e)
        }
        const row = insertObservation({
          profileId,
          proxyId: profile.proxyId,
          host: o.host,
          observedAt: Date.now(),
          kernelVersion,
          via: 'tap',
          tls: toView(o.fp),
          h2: null
        })
        observations.push(row)
      }
    })

    const extraArgs: string[] = []
    if (origin?.cert.spkiList) extraArgs.push(`--ignore-certificate-errors-spki-list=${origin.cert.spkiList}`)

    await launchProfile({
      profile,
      // 观测不访问真实站点，但内核形态必须与平时一致，所以沿用环境的 headless 策略
      headless: opts.headless ?? false,
      proxyOverride: `http://127.0.0.1:${tap.port}`,
      extraArgs
    })

    await navigateAndSettle(profileId, targetUrl)

    // H2 SETTINGS 在 TLS 之内，只有我们自己当服务器才读得到
    const best = origin ? pickOriginSession(origin.sessions, origin.host) : null
    if (best) {
      attachH2(observations, best.h2, origin!.host)
      const row = insertObservation({
        profileId,
        proxyId: profile.proxyId,
        host: best.host,
        observedAt: Date.now(),
        kernelVersion,
        via: 'origin',
        tls: {
          ja3: '',
          ja3String: '',
          ja3Stable: '',
          ja3StableString: '',
          ja3Sorted: '',
          ja3SortedString: '',
          extOrder: '',
          ja4: '',
          ja4r: '',
          versionLabel: best.tlsVersion ?? '',
          sni: best.host,
          alpn: best.alpn ? [best.alpn] : [],
          cipherCount: 0,
          extensionCount: 0,
          greaseCount: 0
        },
        h2: best.h2
      })
      observations.push(row)
    } else if (origin) {
      log('tls', `源服务器有 ${origin.sessions.length} 条会话，但没有一条读到 HTTP/2 前置帧`)
    }

    // 请求头顺序：只在 http/1.1 那条连接上采（h2 的头部走 HPACK）。
    // Chrome 两条链路的头部构造出自同一份代码，所以这里采到的顺序就是 h2 上的顺序。
    let request: HttpRequestHeaders | null = null
    if (h1) {
      try {
        await navigateAndSettle(profileId, h1.url)
      } catch (e) {
        logError('tls', '请求头观测导航失败', e)
      }
      request = h1.sessions.find((s) => s.request)?.request ?? null
      if (!request) log('tls', `请求头观测：h1 有 ${h1.sessions.length} 条会话，但没读到完整请求头`)
    }

    const echo = await readEcho(profileId, opts.echoUrl)

    // 必须优先取「通往观测目标」的那条连接：一次导航里 Chrome 会并行开多条
    // （预连接 gstatic / googleapis 等），取到无关连接会把 SNI 判成不一致，
    // 还会让基线比对拿错样本。
    const host = new URL(targetUrl).hostname
    const primary =
      observations.find((o) => o.via === 'tap' && o.host === host) ??
      observations.find((o) => o.via === 'tap') ??
      observations[0]
    if (!primary) return emptyResult(profileId, profile.name, '没有观测到任何 TLS 握手：内核可能没走本机 tap')

    const baseline = getBaseline(kernelVersion)
    const items = compareTls({
      tls: primary.tls,
      h2: primary.h2,
      baseline,
      declaredMajor: profile.fingerprint ? chromeMajor(profile.fingerprint.ua.ua) : null,
      kernelVersion,
      host,
      echo: echo ? { ja4: echo.ja4, h2fp: echo.h2fp, httpVersion: echo.httpVersion } : null,
      sniNotApplicable: sniNotApplicable(host)
    })

    // 请求头分析并入同一份报告：顺序、大小写、中间设备注入、与 profile 是否自洽
    if (request) items.push(...analyzeHeaders({ request, fp: profile.fingerprint }))

    const ok = items.filter((i) => i.status === 'ok').length
    const mismatch = items.filter((i) => i.status === 'mismatch').length
    const unknown = items.filter((i) => i.status === 'unknown').length
    const judged = ok + mismatch

    // tls.autoBaseline：新内核版本还没有基线时，把本次观测的形状记为基线。
    // 之前这个设置项定义了但从未被读取，界面上改了没有任何效果。
    // 必须放在比对**之后**：否则本次观测既当样本又当基线，
    // 比对结果必然全绿 —— 那是自证清白，不是检测。
    if (!baseline && typedSetting<boolean>('tls.autoBaseline', true)) {
      const major = chromeMajor(kernelVersion)
      if (major !== null) {
        const built = buildBaseline(kernelVersion, major)
        if (built) log('tls', `已按本次观测自动建立基线 ${kernelVersion} JA4=${built.ja4}（下次观测起生效）`)
      }
    }

    log('tls', `${profile.name} TLS 观测完成：JA4=${primary.tls.ja4} ok=${ok} mismatch=${mismatch}`)
    return {
      profileId,
      name: profile.name,
      at: Date.now(),
      targetUrl,
      kernelVersion,
      observations,
      baseline,
      echo,
      request,
      items,
      ok,
      mismatch,
      unknown,
      score: judged === 0 ? 0 : Math.round((ok / judged) * 100),
      error: null
    }
  } finally {
    await tap?.stop().catch(() => undefined)
    await origin?.stop().catch(() => undefined)
    await h1?.stop().catch(() => undefined)
    await stopProfile(profileId).catch(() => undefined)
    // 恢复用户原本的状态：观测不该悄悄把正在运行的环境关掉
    if (wasRunning) {
      const fresh = getProfile(profileId)
      if (fresh) await launchProfile({ profile: fresh }).catch((e: unknown) => logError('tls', '恢复环境失败', e))
    }
  }
}

/**
 * 让内核自己去访问回显服务，读「服务端看到的」形状。
 * 这一步是可选的：没有自建回显服务时整条检测仍然成立，只是少了一路交叉验证。
 */
async function readEcho(profileId: string, echoUrlOpt?: string): Promise<EchoReport | null> {
  const echoUrl = echoUrlOpt ?? String(typedSetting<string>('tls.echoUrl', ''))
  if (!echoUrl) return null
  const s = getSession(profileId)
  if (!s) return null
  let page = null
  try {
    page = await s.context.newPage()
    await awaitPageInjection(page)
    await page.goto(echoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    const body = await page.evaluate('document.body ? document.body.innerText : ""')
    const parsed = JSON.parse(String(body)) as Record<string, unknown>
    return {
      url: echoUrl,
      ja3: (parsed.ja3 as string) ?? null,
      ja4: (parsed.ja4 as string) ?? null,
      h2fp: (parsed.http2fp as string) ?? (parsed.h2fp as string) ?? null,
      httpVersion: (parsed.httpVersion as string) ?? (parsed.protocol as string) ?? null,
      raw: parsed
    }
  } catch (e) {
    logError('tls', `回显服务读取失败：${echoUrl}`, e)
    return null
  } finally {
    await page?.close().catch(() => undefined)
  }
}

/** 把本次观测写成该内核版本的基线（首次检测后点「设为基线」） */
export function promoteBaseline(profileId: string): TlsBaseline {
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`环境不存在：${profileId}`)
  const obs = listObservations(profileId, 5).filter((o) => o.via === 'tap')
  if (!obs.length) throw new Error('还没有该环境的 TLS 观测记录，先跑一次检测')
  const kernelVersion = obs[0].kernelVersion
  const major = chromeMajor(kernelVersion)
  if (major === null) throw new Error(`内核版本号无法解析主版本：${kernelVersion}`)
  const built = buildBaseline(kernelVersion, major)
  if (!built) throw new Error('基线构建失败：观测样本不足')
  log('tls', `已建立基线 ${kernelVersion} JA4=${built.ja4} 样本=${built.samples}`)
  return built
}

export function baselines(): TlsBaseline[] {
  return listBaselines()
}

export function history(profileId: string, limit = 20): TlsObservation[] {
  return listObservations(profileId, limit)
}

/** 新内核版本还没有基线时给出提示，避免界面把「unknown」显示成「没问题」 */
export function missingBaselines(): string[] {
  return kernelsWithoutBaseline()
}