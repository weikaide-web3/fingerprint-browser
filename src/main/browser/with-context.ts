import type { BrowserContext } from 'playwright-core'
import { getSession } from './registry'
import { launchProfile, stopProfile } from './launcher'
import { getProfile } from '../db/repositories/profiles'
import { typedSetting } from '../settings/defs'
import { log } from '../lib/log'

/**
 * 「一定要在真实内核里做」的操作统一走这里。
 * 环境已运行就复用它的 context；没运行就临时拉起同一个 profile，
 * 用完立刻关掉 —— 这样 cookie / 检测 / 自动化拿到的都是内核实际使用的那份状态，
 * 而不是去读磁盘上加密的 SQLite。
 */

export interface WithContextOptions {
  /**
   * 是否以 headless 临时拉起。不传则读设置项 transientHeadless（默认 false = 有头）。
   *
   * headless 不是「看不见窗口」这么简单：渲染管线、requestAnimationFrame 时序、
   * serviceWorker 注册、GPU 光栅化路径都与有头模式不同，Google / X 会把它们
   * 当成另一类设备。所以默认必须是有头 —— 宁可让用户看见窗口，也不要静默换身份。
   */
  headless?: boolean
  /**
   * 声明「这次操作会访问真实站点」。为 true 时无条件强制有头模式，
   * 即使用户把 transientHeadless 打开了也不生效：登录、发帖、RPA 都属于这类。
   */
  realSite?: boolean
}

export async function withContext<T>(
  profileId: string,
  purpose: string,
  fn: (ctx: BrowserContext, reused: boolean) => Promise<T>,
  opts: WithContextOptions = {}
): Promise<T> {
  const existing = getSession(profileId)
  if (existing) return fn(existing.context, true)
  // 同一环境的并发临时操作串行化：否则两个 withContext 会各自拉起/关闭同一个
  // profile，先结束的一方会关掉另一方正在使用的 context。
  return runExclusive(profileId, () => withContextInner(profileId, purpose, fn, opts))
}

async function withContextInner<T>(
  profileId: string,
  purpose: string,
  fn: (ctx: BrowserContext, reused: boolean) => Promise<T>,
  opts: WithContextOptions
): Promise<T> {
  // 进入串行区后再次检查：可能前一个任务已经把环境拉起来了
  const existing = getSession(profileId)
  if (existing) return fn(existing.context, true)
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`环境不存在：${profileId}`)

  let headless = opts.headless ?? typedSetting<boolean>('transientHeadless', false)
  if (opts.realSite && headless) {
    log('context', `「${purpose}」会访问真实站点，已强制改用有头模式（headless 会被识别为另一类设备）：${profile.name}`)
    headless = false
  }
  log('context', `环境未运行，临时以${headless ? ' headless' : '有头'}模式拉起以${purpose}：${profile.name}`)
  const launched = await launchProfile({ profile, headless })
  // 只有「这次真的是我拉起来的」才由我负责关掉。
  // 否则会出现：自动化 API 正在启动某环境，同时一个检测/会话操作也走这里，
  // 操作跑完就把 API 刚拉起的内核关掉 —— 用户的脚本连不上，且症状难以归因。
  const weSpawned = launched.spawned
  try {
    const s = getSession(profileId)
    if (!s) throw new Error('内核未能启动')
    return await fn(s.context, !weSpawned)
  } finally {
    if (weSpawned) await stopProfile(profileId).catch(() => undefined)
  }
}

// 按 profileId 维护一条 Promise 链，保证同一环境的临时操作互斥。
const chains = new Map<string, Promise<unknown>>()
function runExclusive<T>(profileId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(profileId) ?? Promise.resolve()
  // 链尾吞掉错误：一次失败不应阻断后续排队任务
  const next = prev.then(task, task)
  const tail = next.then(
    () => undefined,
    () => undefined
  )
  chains.set(profileId, tail)
  void tail.finally(() => {
    // 只有当自己仍是链尾时才清理，防止 Map 无限增长
    if (chains.get(profileId) === tail) chains.delete(profileId)
  })
  return next
}