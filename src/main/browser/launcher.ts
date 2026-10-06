import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { ensureDir, profileDownloadsDir, profileUserDataDir } from '../paths'
import { resolveChromiumExecutable } from './executable'
import { setSession, getSession, deleteSession, allSessions, activeIds } from './registry'
import { applyFingerprint, awaitPageInjection } from '../fingerprint/injector'
import { startRelay, type RelayHandle } from '../proxy/relay'
import { getProxyPassword } from '../db/repositories/proxies'
import { decryptSecret } from '../lib/crypto'
import { buildLaunchArgs, parseArgsTemplate } from './args'
import { typedSetting } from '../settings/defs'
import { attachForProfile as attachWebAuthn, clearAttached as clearWebAuthn } from '../services/webauthn'
import { pathsForProfile as getExtensionPaths } from '../services/extensions'
import { log, logError } from '../lib/log'
import type { BrowserLaunchResult, Profile } from '@shared/types'

export interface LaunchOptions {
  profile: Profile
  headless?: boolean
  urls?: string[]
  debugPort?: number
  extraArgs?: string[]
  /**
   * 覆盖「隐藏测试版/建议更新黄条」设置。
   * 不传则读设置项。给自动化 API 与测试留的显式开关 —— 想复现黄条做对照实验时必须有它。
   */
  suppressBuildInfobar?: boolean
  /** 覆盖「隐藏不受支持命令行标记黄条」设置 */
  suppressFlagInfobar?: boolean
  /**
   * 覆盖代理入口，形如 http://127.0.0.1:34567。
   * TLS 观测要用：把环境的流量临时引到本机 tap 上，同时跳过环境自身的
   * relay 路径（tap 会自己接上游代理，观测到的仍是真实出口链路）。
   */
  proxyOverride?: string
  /** 进程自然退出（用户点 X）时的回调，用于通知 UI */
  onExit?: () => void
}

/**
 * 已分配出去的调试端口。
 *
 * findFreePort 的做法是 listen(0) 拿到端口后立刻 close —— 但 close 之后端口就回到
 * 空闲池，两次并发调用完全可能拿到同一个端口，第二个 Chrome 会绑不上调试端口而
 * 静默失败。这里把分配过的端口先扣在集合里，直到会话关闭才释放。
 */
const reservedPorts = new Set<number>()

export function releasePort(port: number): void {
  reservedPorts.delete(port)
}

function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0))
    })
  })
}

async function findFreePort(preferred?: number): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = attempt === 0 && preferred ? preferred : await pickEphemeralPort()
    if (!port) continue
    if (reservedPorts.has(port)) continue
    if (await portInUse(port)) continue
    reservedPorts.add(port)
    return port
  }
  throw new Error('找不到可用的调试端口，请检查是否有残留的 Chrome 进程')
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.setTimeout(1000, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

async function waitForDevTools(port: number, proc: ChildProcess, timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`内核进程已退出 (code=${proc.exitCode})`)
    const url = await new Promise<string | null>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve((JSON.parse(body).webSocketDebuggerUrl as string) ?? null)
          } catch {
            resolve(null)
          }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => {
        req.destroy()
        resolve(null)
      })
    })
    if (url) return url
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('等待 DevTools 端口超时')
}

// 单飞（single-flight）：同一 profileId 的并发启动共享同一次 spawn，
// 避免两个调用（API start + UI start，或两个 withContext）都看到「无会话」
// 而各自 spawn Chrome 抢同一 userDataDir → 撞 SingletonLock / 损坏 profile。
const launchInflight = new Map<string, Promise<BrowserLaunchResult>>()

/**
 * launchProfile 的返回值：在公开契约之外多带一个 spawned。
 *
 * spawned=false 意味着「这次调用只是复用了别人已经启动的会话」。
 * 调用方（withContext）必须据此决定用完要不要关掉 —— 否则会出现：
 * API 正在启动某环境，同时一个检测操作也走 withContext，
 * 检测跑完把 API 刚拉起的内核关掉，用户的脚本连不上。
 */
export interface LaunchResult extends BrowserLaunchResult {
  spawned: boolean
}

export async function launchProfile(opts: LaunchOptions): Promise<LaunchResult> {
  const existing = getSession(opts.profile.id)
  if (existing) {
    return {
      profileId: existing.profileId,
      wsEndpoint: existing.wsEndpoint,
      httpEndpoint: existing.httpEndpoint,
      pid: existing.pid,
      startedAt: existing.startedAt,
      spawned: false
    }
  }
  const inflight = launchInflight.get(opts.profile.id)
  if (inflight) return { ...(await inflight), spawned: false }
  const p = doLaunch(opts).finally(() => launchInflight.delete(opts.profile.id))
  launchInflight.set(opts.profile.id, p)
  return p
}

async function doLaunch(opts: LaunchOptions): Promise<LaunchResult> {
  // 并发上限在这里，而不是只在 services/browser.ts：
  // withContext（检测 / 会话 / RPA / 健康度）直接调 launchProfile，
  // 放在 service 层等于对「临时拉起」完全不设防，批量检测能一次超限拉起一堆内核。
  const limit = typedSetting<number>('maxConcurrentProfiles', 8)
  if (limit > 0 && activeIds().length >= limit) {
    throw new Error(
      `同时运行的环境已达上限（${limit} 个），请先关闭一些环境，或在设置里调整「同时运行环境上限」`
    )
  }

  const userDataDir = profileUserDataDir(opts.profile.id)
  ensureDir(userDataDir)
  const lock = path.join(userDataDir, 'SingletonLock')
  if (fs.existsSync(lock)) {
    log('browser', `检测到残留 SingletonLock，尝试清理: ${opts.profile.id}`)
    try {
      fs.rmSync(lock, { force: true })
      fs.rmSync(path.join(userDataDir, 'SingletonSocket'), { force: true })
      fs.rmSync(path.join(userDataDir, 'SingletonCookie'), { force: true })
    } catch {
      /* ignore */
    }
  }

  const port = await findFreePort(opts.debugPort)
  const executable = resolveChromiumExecutable()
  const headless = opts.headless ?? typedSetting<boolean>('defaultHeadless', false)

  // 带账号密码的代理：Chrome 的 --proxy-server 不接受凭据，HTTP 会弹认证窗、
  // SOCKS5 认证则完全不支持。所以让 Chrome 连本机 relay，由 relay 转发时补认证。
  let relay: RelayHandle | undefined
  let proxyServerUrl: string | undefined
  const extraArgs: string[] = []
  const bound = opts.profile.proxy
  if (opts.proxyOverride) {
    proxyServerUrl = opts.proxyOverride
    log('browser', `本次启动的代理入口被覆盖为 ${opts.proxyOverride}（TLS 观测）`)
  } else if (bound && opts.profile.proxyMode === 'bind' && (bound.hasPassword || bound.username)) {
    const password = decryptSecret(getProxyPassword(bound.id))
    if (bound.hasPassword && !password) {
      throw new Error(`代理「${bound.name}」的密码无法解密，请重新填写后再打开`)
    }
    relay = await startRelay(
      {
        scheme: bound.scheme,
        host: bound.host,
        port: bound.port,
        username: bound.username,
        password
      },
      { preferredPort: typedSetting<number>('relayPort', 0) }
    )
    proxyServerUrl = `socks5://127.0.0.1:${relay.port}`
    // socks5:// 让 Chrome 把域名交给对端解析；再显式禁掉本地解析，
    // 否则 DNS 查询会走本机，既泄漏真实位置也可能被污染。
    extraArgs.push('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost')
    log('browser', `代理 ${bound.name} 需要认证，改走本机 relay socks5://127.0.0.1:${relay.port}`)
  } else if (bound && opts.profile.proxyMode === 'bind' && bound.scheme === 'socks5h') {
    // socks5h：无认证但强制远端 DNS，防止本机 DNS 泄漏真实位置
    extraArgs.push('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost')
    log('browser', `代理 ${bound.name} 为 socks5h，已启用远端 DNS 解析防止泄漏`)
  }

  // 扩展加载：读取该环境绑定的已启用扩展，注入 --load-extension
  try {
    const extPaths = getExtensionPaths(opts.profile.id)
    if (extPaths.length) {
      extraArgs.push(`--load-extension=${extPaths.join(',')}`)
      log('browser', `加载 ${extPaths.length} 个扩展：${extPaths.map((p) => path.basename(p)).join(', ')}`)
    }
  } catch {
    // DB 未初始化时（如集成测试直接构造 profile）跳过扩展加载
  }

  // --host-resolver-rules 会触发 Chrome「不受支持的命令行标记」黄条，
  // 自动补 --test-type 压掉它（仅在 DNS 保护生效时，不影响普通场景的指纹隐蔽性）
  const needsFlagInfobar = extraArgs.some((a) => a.startsWith('--host-resolver-rules='))
  const args = buildLaunchArgs({
    profile: opts.profile,
    userDataDir,
    debugPort: port,
    headless,
    extraArgs: [...(opts.extraArgs ?? []), ...extraArgs],
    proxyServerUrl,
    templateArgs: parseArgsTemplate(String(typedSetting<string>('launchArgsTemplate', ''))),
    suppressBuildInfobar: opts.suppressBuildInfobar ?? typedSetting<boolean>('suppressBuildInfobar', true),
    suppressFlagInfobar: needsFlagInfobar || (opts.suppressFlagInfobar ?? typedSetting<boolean>('suppressFlagInfobar', false))
  })

  let proc: ChildProcess | undefined
  let wsEndpoint: string
  let browser: Browser
  let context: BrowserContext
  try {
    log('browser', `启动 ${opts.profile.name} (${opts.profile.id}) port=${port}`)
    proc = spawn(executable, args, { detached: false, stdio: 'ignore', env: process.env })
    proc.on('exit', (code, signal) => {
      log('browser', `进程退出 ${opts.profile.id} code=${code} signal=${signal ?? '-'}`)
      const session = getSession(opts.profile.id)
      if (session && !session.closing) session.onExit?.()
      void closeSessionHandle(opts.profile.id)
    })

    wsEndpoint = await waitForDevTools(port, proc)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    context = browser.contexts()[0] ?? (await browser.newContext())

    setSession({
      profileId: opts.profile.id,
      context,
      pid: proc.pid ?? 0,
      wsEndpoint,
      httpEndpoint: `http://127.0.0.1:${port}`,
      startedAt: Date.now(),
      status: 'running',
      closing: false,
      headless,
      relay,
      onExit: opts.onExit,
      debugPort: port
    })
  } catch (e) {
    // 启动失败：已经拉起的 Chrome 不能变成孤儿进程，relay 与调试端口也要一并收回
    await relay?.stop().catch(() => undefined)
    releasePort(port)
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    throw e
  }

  // 指纹注入（UA/CH/时区/locale/canvas/webgl/... 全部通过 CDP + init script）
  try {
    await applyFingerprint(browser, context, opts.profile, headless, (b) => {
      const s = getSession(opts.profile.id)
      if (!s) return
      s.windowBounds = b
      if (b.got.width !== b.want.width || b.got.height !== b.want.height) {
        log(
          'browser',
          `窗口被系统按显示器夹小：请求 ${b.want.width}x${b.want.height} → 实际 ${b.got.width}x${b.got.height}`
        )
      }
    })
  } catch (e) {
    // 注入失败意味着「内核起来了但指纹没生效」——继续用等于裸奔，
    // 直接把这个环境关掉并抛错，绝不允许半启动状态留在运行列表里。
    logError('browser', `指纹注入失败，已回滚关闭 ${opts.profile.id}`, e)
    await stopProfile(opts.profile.id).catch(() => undefined)
    throw e
  }

  // 下载目录隔离：必须在打开任何启动 URL 之前设好，
  // 否则首个下载就会落到系统 ~/Downloads。
  await setDownloadDir(browser, opts.profile.id)

  // passkey：挂载虚拟认证器并把该环境已注册的凭证重新注入。
  // 不注入的话，同一个环境每次打开都会被 Google / X 认成「这台设备没有 passkey」，
  // 于是不走 passkey 登录而是降级到手机/邮箱验证 —— 那本身就是风控信号。
  try {
    await attachWebAuthn(opts.profile.id)
  } catch (e) {
    logError('webauthn', '挂载虚拟认证器失败', e)
  }

  const urls = opts.urls?.length ? opts.urls : opts.profile.startupUrls
  for (const u of urls) {
    if (!u) continue
    const page = await context.newPage()
    // 先等 CDP 覆盖落地再导航，否则首个文档请求的 sec-ch-ua / Accept-Language 会退回内核默认值
    await awaitPageInjection(page)
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e: Error) => {
      log('browser', `打开 ${u} 失败: ${e.message}`)
    })
  }

  // macOS 点红叉只关窗口不退出进程 → 监听所有页面关闭后主动 kill
  // 加 1.5s 延迟：检测/RPA 流程会临时关闭所有页面再开新的，不能立即杀
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const checkAllClosed = (): void => {
    const session = getSession(opts.profile.id)
    if (!session || session.closing) return
    if (context.pages().length === 0) {
      // 记住本次会话的 pid：定时器可能在会话被删除后才触发，而这段时间里
      // 同一个环境可能已经被重新启动（新 pid）。不校验 pid 就会误杀新进程。
      const expectedPid = session.pid
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = setTimeout(() => {
        closeTimer = undefined
        const s = getSession(opts.profile.id)
        if (!s || s.closing || s.pid !== expectedPid) return
        if (context.pages().length > 0) return
        log('browser', `所有窗口已关闭，主动退出 ${opts.profile.id}`)
        try { process.kill(s.pid, 'SIGTERM') } catch { /* ignore */ }
      }, 1500)
      // 别让一个待触发的定时器拖住进程退出
      closeTimer.unref?.()
    } else if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = undefined
    }
  }
  context.on('page', (page) => {
    page.on('close', checkAllClosed)
    // 新页面打开时取消待执行的 kill
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined }
  })
  // 对已存在的页面也挂上 close 监听
  for (const page of context.pages()) { page.on('close', checkAllClosed) }

  return {
    profileId: opts.profile.id,
    wsEndpoint,
    httpEndpoint: `http://127.0.0.1:${port}`,
    pid: proc.pid ?? 0,
    startedAt: Date.now(),
    spawned: true
  }
}

async function closeSessionHandle(profileId: string): Promise<void> {
  const session = getSession(profileId)
  if (!session) return
  deleteSession(profileId)
  clearWebAuthn(profileId)
  if (session.debugPort) releasePort(session.debugPort)
  try {
    await session.context.close()
  } catch {
    /* ignore */
  }
  await session.relay?.stop().catch(() => undefined)
}

export async function stopProfile(profileId: string): Promise<boolean> {
  const session = getSession(profileId)
  if (!session) return false
  session.closing = true
  const browser = session.context.browser()
  try {
    await session.context.close()
  } catch {
    /* ignore */
  }
  try {
    await browser?.close()
  } catch {
    /* ignore */
  }
  try {
    process.kill(session.pid, 'SIGTERM')
  } catch {
    /* ignore */
  }
  deleteSession(profileId)
  clearWebAuthn(profileId)
  if (session.debugPort) releasePort(session.debugPort)
  await session.relay?.stop().catch(() => undefined)
  return true
}

export async function stopAllProfiles(): Promise<void> {
  await Promise.all(allSessions().map((s) => stopProfile(s.profileId)))
}

/**
 * 把该环境的下载目录隔离到 profiles/<id>/downloads。
 *
 * 为什么不用命令行：Chromium 没有 --download-path 这个开关（实测传了被静默忽略，
 * 文件落到系统 ~/Downloads）。唯一可靠的入口是 CDP 的 Browser.setDownloadBehavior，
 * 它是 browser 级生效，覆盖之后创建的所有 context 与页面。
 *
 * 为什么必须隔离：多个环境的下载混在同一个 ~/Downloads 里，
 * 环境 A 下载的账单/凭证会出现在环境 B 的可见范围内，属于跨身份泄漏。
 */
async function setDownloadDir(browser: Browser, profileId: string): Promise<void> {
  const dir = ensureDir(profileDownloadsDir(profileId))
  try {
    const cdp = await browser.newBrowserCDPSession()
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dir,
      eventsEnabled: true
    })
    log('browser', `下载目录已隔离到 ${dir}`)
  } catch (e) {
    // 不阻断启动：指纹已经生效，下载目录失败只是体验/泄漏问题，
    // 但必须显式记录，否则用户以为隔离生效了。
    logError('browser', `设置下载目录失败（下载会落到系统 ~/Downloads，存在跨环境泄漏）${profileId}`, e)
  }
}
