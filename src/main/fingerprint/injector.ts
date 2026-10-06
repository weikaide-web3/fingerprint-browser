import type { Browser, BrowserContext, Page } from 'playwright-core'
import { buildFingerprintScript } from './script'
import { log, logError } from '../lib/log'
import type { FingerprintConfig, Profile } from '@shared/types'

interface PageSession {
  page: Page
  cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>
}

const pageSessions = new WeakMap<BrowserContext, PageSession[]>()

/**
 * 每个页面「注入是否已完成」的 promise。
 * context.on('page') 是事件回调，调用方（launcher 新建 page 后）无法直接 await 它；
 * 把 promise 存起来，导航前 awaitPageInjection 一下，就不会出现
 * 「goto 抢在 CDP setUserAgentOverride 落地前」导致线上 sec-ch-ua 还是内核默认值的竞态。
 */
const pageInjection = new WeakMap<Page, Promise<void>>()

/** 导航前调用：确保该页的 CDP 覆盖（UA/CH/时区/locale/...）已经生效 */
export async function awaitPageInjection(page: Page): Promise<void> {
  const p = pageInjection.get(page)
  if (p) await p
}

function sessionsFor(context: BrowserContext): PageSession[] {
  let list = pageSessions.get(context)
  if (!list) {
    list = []
    pageSessions.set(context, list)
  }
  return list
}

function clientHintsMetadata(fp: FingerprintConfig): {
  brands: { brand: string; version: string }[]
  fullVersionList: { brand: string; version: string }[]
  platform: string
  platformVersion: string
  architecture: string
  bitness: string
  model: string
  mobile: boolean
  fullVersion: string
  wow64: boolean
} {
  const ch = fp.clientHints
  // 刻意不带 formFactors：实测本机内核（Chrome 154）的 CDP UserAgentMetadata schema
  // 不接受该字段，一旦带上整个 setUserAgentOverride 会返回 "Invalid parameters" 被整体拒绝，
  // 于是线上 sec-ch-ua 头退回内核默认值，而 JS 补丁已把 navigator.userAgentData 改成配置值
  // —— 反而制造「JS 与请求头不一致」的穿帮。formFactors 只在 JS 补丁里呈现。
  //
  // 字段名是 fullVersion，不是 uaFullVersion：CDP 的 UserAgentMetadata 用 fullVersion 承载
  // 浏览器完整版本，它映射到 JS 侧 getHighEntropyValues('uaFullVersion')。写成 uaFullVersion
  // 会被当成未知字段忽略，于是 JS 侧 uaFullVersion 退回空串（线上头却正常）—— 又是一处穿帮。
  return {
    brands: ch.brands,
    fullVersionList: ch.fullVersionList,
    platform: ch.platform,
    platformVersion: ch.platformVersion,
    architecture: ch.architecture,
    bitness: ch.bitness,
    model: ch.model,
    mobile: ch.mobile,
    fullVersion: ch.uaFullVersion,
    wow64: ch.wow64
  }
}

/** 页面/上下文在注入过程中被关掉是正常竞态（RPA 跑完就关页），不该刷错误日志 */
function isTargetGone(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /Target (page|context|browser) has been closed|Browser has been closed|Connection (closed|is closed)/i.test(m)
}

function noteFailure(label: string, e: unknown): void {
  if (isTargetGone(e)) log('fingerprint', `${label}：目标已关闭，跳过该页`)
  else logError('fingerprint', label, e)
}

async function applyPerPage(
  context: BrowserContext,
  fp: FingerprintConfig,
  page: Page,
  headless: boolean,
  onWindowBounds?: (b: WindowBounds) => void
): Promise<void> {
  if (page.isClosed()) return
  let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>
  try {
    cdp = await context.newCDPSession(page)
  } catch (e) {
    // 页面在事件回调排队期间就被关掉了，属于正常竞态，不该刷错误
    log('fingerprint', '页面已关闭，跳过该页的 CDP 覆盖')
    return
  }
  sessionsFor(context).push({ page, cdp })
  page.on('close', () => {
    const list = sessionsFor(context)
    const idx = list.findIndex((s) => s.page === page)
    if (idx >= 0) list.splice(idx, 1)
  })

  try {
    await cdp.send('Page.enable')
  } catch (e) {
    noteFailure('Page.enable 失败', e)
  }

  // 把真实窗口开成 profile 配置的尺寸。
  // 我们不再改写 innerWidth / innerHeight / clientHeight —— 那些值由内核按真实窗口排版，
  // 改一半必然留下「window 说 740、引擎实际用 657」的缺口（内核实测差 83px）。
  // 让真实窗口等于配置，真实值本身就对得上，无需撒谎。
  // headless 没有真实窗口，跳过以免 CDP 报错刷屏。
  if (!headless && fp.screen.windowWidth > 0 && fp.screen.windowHeight > 0) {
    try {
      const info = await cdp.send('Browser.getWindowForTarget')
      const b = info.bounds
      const wantW = fp.screen.windowWidth
      const wantH = fp.screen.windowHeight
      if (b.width !== wantW || b.height !== wantH) {
        await cdp.send('Browser.setWindowBounds', {
          windowId: info.windowId,
          bounds: { width: wantW, height: wantH }
        })
        log('fingerprint', `窗口已按配置调整 ${b.width}x${b.height} → ${wantW}x${wantH}`)
      }
      // 读回内核真正落地的尺寸。setWindowBounds 不会报错，但窗口管理器会把
      // 超出显示器工作区的窗口直接夹小（本机实测：请求 2812x1815 → 落地 2812x833）。
      // 只有读回来才知道「对不上」是系统夹取还是注入撒谎，检测页据此区分。
      const back = await cdp.send('Browser.getWindowForTarget')
      onWindowBounds?.({
        want: { width: wantW, height: wantH },
        got: { width: Number(back.bounds.width ?? 0), height: Number(back.bounds.height ?? 0) }
      })
    } catch (e) {
      noteFailure('窗口尺寸调整失败', e)
    }
  }

  try {
    // 刻意不传 acceptLanguage：实测它会把 Accept-Language 拼成
    // "en-US,en;q=0.9,en;q=0.9;q=0.8" 这种没有任何真实 Chrome 会发的形状
    // （启动参数 --accept-lang 已经给了正确值，CDP 再叠一层就重复了）。
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: fp.ua.ua,
      platform: fp.hardware.platform,
      userAgentMetadata: fp.clientHints.enabled ? clientHintsMetadata(fp) : undefined
    })
  } catch (e) {
    noteFailure('UA/ClientHints 覆盖失败', e)
  }

  try {
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone.id })
  } catch (e) {
    noteFailure(`时区覆盖失败 (${fp.timezone.id})`, e)
  }

  try {
    await cdp.send('Emulation.setLocaleOverride', { locale: fp.language.intlLocale })
  } catch (e) {
    noteFailure('locale 覆盖失败', e)
  }

  if (fp.geolocation.enabled && fp.geolocation.permission !== 'block') {
    try {
      await cdp.send('Emulation.setGeolocationOverride', {
        latitude: fp.geolocation.latitude,
        longitude: fp.geolocation.longitude,
        accuracy: fp.geolocation.accuracy,
        altitude: fp.geolocation.altitude ?? undefined,
        altitudeAccuracy: fp.geolocation.altitudeAccuracy ?? undefined,
        heading: fp.geolocation.heading ?? undefined,
        speed: fp.geolocation.speed ?? undefined
      })
    } catch (e) {
      noteFailure('地理位置覆盖失败', e)
    }
  }

  const extraHeaders = fp.headers.extra
  if (Object.keys(extraHeaders).length) {
    try {
      await cdp.send('Network.enable')
      await cdp.send('Network.setExtraHTTPHeaders', { headers: extraHeaders })
    } catch (e) {
      noteFailure('附加请求头设置失败', e)
    }
  }

  if (fp.launch.bypassCSP) {
    try {
      await cdp.send('Page.setBypassCSP', { enabled: true })
    } catch {
      /* ignore */
    }
  }
}

/** 请求的窗口尺寸 vs 窗口管理器真正落地的尺寸（后者可能被显示器夹小） */
export interface WindowBounds {
  want: { width: number; height: number }
  got: { width: number; height: number }
}

export async function applyFingerprint(
  browser: Browser,
  context: BrowserContext,
  profile: Profile,
  headless = false,
  onWindowBounds?: (b: WindowBounds) => void
): Promise<void> {
  const fp = profile.fingerprint
  if (!fp) {
    log('fingerprint', `profile ${profile.id} 无指纹配置，跳过注入`)
    return
  }
  void browser

  // JS 层补丁：注册到整个上下文，对之后创建/导航的所有文档生效
  const script = buildFingerprintScript(fp)
  try {
    await context.addInitScript({ content: script })
  } catch (e) {
    logError('fingerprint', 'addInitScript 失败，回退到逐页 CDP 注入', e)
    const cdp = await context.newCDPSession(context.pages()[0] ?? (await context.newPage()))
    await cdp.send('Page.enable')
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script })
  }

  const apply = async (page: Page): Promise<void> => {
    try {
      await applyPerPage(context, fp, page, headless, onWindowBounds)
    } catch (e) {
      logError('fingerprint', '页面注入失败', e)
    }
  }
  // 新建页：把注入 promise 存进 WeakMap，导航前可 awaitPageInjection 等待它完成。
  // 不存的话调用方只能盲发 goto，会抢在 CDP 覆盖落地前 → 线上头退回内核默认值。
  context.on('page', (page) => {
    const p = apply(page)
    pageInjection.set(page, p)
    page.on('close', () => pageInjection.delete(page))
  })
  for (const page of context.pages()) {
    const p = apply(page)
    pageInjection.set(page, p)
    await p
  }
  log('fingerprint', `已注入指纹 ${profile.id} seed=${fp.seed}`)
}
