import { randomBytes } from 'node:crypto'
import type { BrowserContext, Page } from 'playwright-core'
import { getSession } from '../browser/registry'
import { isDbReady } from '../db'
import { getProfile } from '../db/repositories/profiles'
import { addCredential, countCredentials, listCredentials, removeCredential, touchCredential } from '../db/repositories/webauthn'
import {
  addVirtualAuthenticator,
  enableWebAuthn,
  injectCredentials,
  readAttachedCredentials,
  removeVirtualAuthenticator,
  type Cdp
} from '../webauthn/attach'
import { parseAttestationObject, parseAuthData, rpIdHashHex, describeFlags, FLAG } from '../webauthn/cbor'
import { PAGE_CREATE, PAGE_GET } from '../webauthn/page'
import { log, logError } from '../lib/log'
import type { WebAuthnCredential, WebAuthnCredentialView, WebAuthnEnrollResult, WebAuthnStatus } from '@shared/webauthn'
import type { WebAuthnConfig } from '@shared/webauthn'

/**
 * Passkey / WebAuthn 服务。
 *
 * 以下约束全部是在真实内核里实测得到的（不是照抄 CDP 文档）：
 *  1. **一个环境只能有一个 internal（平台）虚拟认证器**：
 *     第二次 addVirtualAuthenticator 直接报
 *     `Chrome only supports one internal authenticator per environment`；
 *  2. 认证器**按创建它的 CDP 会话（页面 target）作用域**生效：别的页面即使
 *     WebAuthn.enable 也看不到它（报 "operation ... not allowed"），
 *     用同一个 authenticatorId 去别的会话 getCredentials 会报 "Could not find"；
 *  3. 因此正确做法是**交接（handoff）**：先从旧页面 removeVirtualAuthenticator，
 *     再在新页面 add —— 实测交接后新页面注册/断言都正常，且
 *     authenticatorAttachment 仍是 "platform"（用 usb 传输会变成 "cross-platform"，
 *     那是另一类设备信号，不能拿来做 Touch ID / Windows Hello 的伪装）；
 *  4. 内核里没有任何认证器时，navigator.credentials.create 会**永久挂住**
 *     （连 timeout 都不触发），所以绝不能「只在需要时才 enable」就完事；
 *  5. CDP 没有 aaguid 参数（内核随机生成），但 getCredentials 会回传 PKCS#8 私钥
 *     与 userHandle —— 所以持久化 credentialId + 私钥并重新注入，才能保证
 *     「同一环境下次登录仍是同一把 passkey」；
 *  6. addCredential 对 resident 凭证必须带 userHandle，否则报协议错误。
 */

export interface Attached {
  authenticatorId: string
  injected: number
  failed: { credentialId: string; error: string }[]
  /** 内核实际生成的 AAGUID（注册后才知道） */
  observedAaguid: string | null
  cdp: Cdp
  page: Page
}

/** 每个环境当前持有认证器的页面（内核限制：一个环境只能有一个 internal 认证器） */
const attached = new Map<string, Attached>()
/** 已经注册过「新页面自动交接」钩子的 context，避免重复监听 */
const hooked = new WeakSet<BrowserContext>()
/** 每个环境串行执行挂载/交接，避免「新页面钩子」与显式调用互相抢认证器 */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(profileId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(profileId) ?? Promise.resolve()
  const next = prev.then(task)
  queues.set(
    profileId,
    next.catch(() => undefined)
  )
  return next
}

export function clearAttached(profileId: string): void {
  attached.delete(profileId)
  queues.delete(profileId)
}

function configOf(profileId: string): WebAuthnConfig | null {
  // 集成测试与部分服务路径不会开库（原生模块按 Electron ABI 编译），
  // 这时应当安静地跳过 passkey 挂载，而不是刷一条堆栈噪音。
  if (!isDbReady()) return null
  const p = getProfile(profileId)
  return p?.fingerprint?.webauthn ?? null
}

function injectionList(profileId: string, cfg: WebAuthnConfig) {
  return listCredentials(profileId).map((c) => ({
    credentialId: c.credentialId,
    rpId: c.rpId,
    privateKey: c.privateKey,
    userHandle: c.userHandle,
    userName: c.userName,
    signCount: c.signCount,
    isResidentCredential: c.isResidentCredential,
    isSynced: cfg.isSynced
  }))
}

/** 把页面脚本字符串变成真正的函数对象：Playwright 按 toString() 序列化，源码原样送达 */
function pageFn(source: string): (...args: unknown[]) => unknown {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${source})`)() as (...args: unknown[]) => unknown
}

/**
 * 摘掉当前页面持有的认证器。
 * 内核限制「一个环境只能有一个 internal 认证器」，所以挂到新页面前必须先摘。
 */
async function detachCurrent(profileId: string): Promise<void> {
  const cur = attached.get(profileId)
  if (!cur) return
  attached.delete(profileId)
  await removeVirtualAuthenticator(cur.cdp, cur.authenticatorId)
  // 这个 CDP 会话之后没人用了，顺手关掉 WebAuthn 域，避免残留状态
  await cur.cdp.send('WebAuthn.disable').catch(() => undefined)
}

/** 给某个页面挂认证器并注入已保存的凭证（不做交接；调用方负责先摘） */
async function mountOnPage(profileId: string, page: Page): Promise<Attached | null> {
  const cfg = configOf(profileId)
  if (!cfg || !cfg.enabled) return null
  const session = getSession(profileId)
  if (!session || page.isClosed()) return null

  const cdp = await session.context.newCDPSession(page)
  if (!(await enableWebAuthn(cdp))) return null
  const authenticatorId = await addVirtualAuthenticator(cdp, cfg)
  if (!authenticatorId) {
    await cdp.send('WebAuthn.disable').catch(() => undefined)
    return null
  }
  const { injected, failed } = await injectCredentials(cdp, authenticatorId, injectionList(profileId, cfg))
  const state: Attached = { authenticatorId, injected, failed, observedAaguid: null, cdp, page }
  attached.set(profileId, state)
  page.once('close', () => {
    // 持有者关掉了：把认证器交接给还活着的页面，否则用户下一页的 passkey 会挂死
    if (attached.get(profileId) === state) {
      attached.delete(profileId)
      void handoffToAnyPage(profileId).catch((e: unknown) => logError('webauthn', '页面关闭后交接失败', e))
    }
  })
  return state
}

/** 把认证器交给指定页面（先摘旧的） */
async function attachToPage(profileId: string, page: Page): Promise<Attached | null> {
  const current = attached.get(profileId)
  if (current && current.page === page && !page.isClosed()) return current
  await detachCurrent(profileId)
  return mountOnPage(profileId, page)
}

/** 交给任意一个还活着的页面（优先最近打开的，用户多半在那一页操作） */
async function handoffToAnyPage(profileId: string): Promise<Attached | null> {
  const session = getSession(profileId)
  if (!session) return null
  const pages = session.context.pages().filter((p) => !p.isClosed())
  for (const page of pages.reverse()) {
    const state = await attachToPage(profileId, page)
    if (state) return state
  }
  return null
}

/** 环境启动后由 launcher 调用：挂到当前页面，并让之后新开的页面自动接管 */
export async function attachForProfile(profileId: string): Promise<Attached | null> {
  return enqueue(profileId, async () => {
    const existing = attached.get(profileId)
    if (existing && !existing.page.isClosed()) return existing

    const cfg = configOf(profileId)
    if (!cfg || !cfg.enabled) return null
    const session = getSession(profileId)
    if (!session) return null
    const context = session.context

    if (!hooked.has(context)) {
      hooked.add(context)
      context.on('page', (page) => {
        // 新页面一开就把认证器接过来：内核只允许一个 internal 认证器，
        // 不接管的话旧页面会一直占着，新页面里的 passkey 永远挂住。
        void enqueue(profileId, () => attachToPage(profileId, page)).catch((e: unknown) =>
          logError('webauthn', '新页面接管认证器失败', e)
        )
      })
    }

    const pages = context.pages().filter((p) => !p.isClosed())
    if (!pages.length) {
      const page = await context.newPage()
      return mountOnPage(profileId, page)
    }
    return attachToPage(profileId, pages[pages.length - 1])
  })
}

/**
 * 在一次性页面上完成一次 WebAuthn 操作（注册 / 断言）。
 * 刻意不复用用户正在浏览的页面：注册流程会跳转，不该打断人的操作。
 * 用完必须把认证器交还给原来的页面 —— 否则用户下一页的 passkey 会挂死。
 */
async function withDedicatedPage<T>(
  profileId: string,
  url: string,
  fn: (page: Page, state: Attached) => Promise<T>
): Promise<T> {
  const session = getSession(profileId)
  if (!session) throw new Error('环境未运行')
  const page = await session.context.newPage()
  let state: Attached | null = null
  try {
    // 走队列：与「新页面钩子」的接管互斥，否则会撞车（内核只允许一个）
    state = await enqueue(profileId, () => attachToPage(profileId, page))
    if (!state) {
      throw new Error('无法挂载虚拟认证器：内核可能不支持 WebAuthn CDP 域，或该环境已关闭 WebAuthn')
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return await fn(page, state)
  } finally {
    await enqueue(profileId, async () => {
      if (state) await removeVirtualAuthenticator(state.cdp, state.authenticatorId)
      if (attached.get(profileId)?.page === page) attached.delete(profileId)
      await page.close().catch(() => undefined)
      // 交还给用户仍在看的页面
      await handoffToAnyPage(profileId)
    })
  }
}

export function attachedState(profileId: string): Attached | null {
  return attached.get(profileId) ?? null
}

export function status(profileId: string): WebAuthnStatus {
  const cfg = configOf(profileId)
  const state = attached.get(profileId)
  const issues: string[] = []
  if (!cfg) issues.push('该环境没有指纹配置，无法挂载虚拟认证器')
  else if (!cfg.enabled) issues.push('指纹配置里已关闭 WebAuthn')
  else if (!state) issues.push('环境未运行：passkey 只在环境运行时挂载（下次打开会自动注入）')
  return {
    profileId,
    attached: Boolean(state),
    authenticatorId: state?.authenticatorId ?? null,
    configured: cfg,
    credentials: countCredentials(profileId),
    attachedCredentials: state?.injected ?? 0,
    issues
  }
}

/**
 * 给界面用的凭证列表：**剥掉私钥**。
 * 私钥 + credentialId 就等于这台设备的 passkey 能力，不能进渲染进程。
 * 主进程内部要私钥时直接用 listCredentials（仅注入/断言路径）。
 */
export function list(profileId: string): WebAuthnCredentialView[] {
  return listCredentials(profileId).map(toView)
}

function toView(c: WebAuthnCredential): WebAuthnCredentialView {
  return {
    id: c.id,
    profileId: c.profileId,
    rpId: c.rpId,
    rpName: c.rpName,
    userHandle: c.userHandle,
    userName: c.userName,
    publicKey: c.publicKey,
    credentialId: c.credentialId,
    signCount: c.signCount,
    isResidentCredential: c.isResidentCredential,
    hasPrivateKey: Boolean(c.privateKey),
    aaguid: c.aaguid,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    source: c.source,
    note: c.note
  }
}

export function remove(id: string): boolean {
  return removeCredential(id)
}

/** passkey 必须注册在真实运行中的环境里，所以必要时先把环境拉起来 */
async function ensureRunning(profileId: string): Promise<void> {
  if (getSession(profileId)) return
  const { startProfile } = await import('./browser')
  await startProfile(profileId, {})
  if (!getSession(profileId)) throw new Error('环境未能启动')
}

export interface EnrollInput {
  rpId: string
  rpName?: string
  userName?: string
  userHandle?: string
  /** 注册页面地址；默认 https://<rpId>/。测试可用 http://127.0.0.1:<port>/ */
  origin?: string
}

/** 在真实内核里走完整注册流程 —— 只有内核真的生成密钥，站点侧的注册关系才成立 */
export async function enroll(profileId: string, input: EnrollInput): Promise<WebAuthnEnrollResult> {
  const rpId = String(input.rpId ?? '').trim().toLowerCase()
  if (!rpId) throw new Error('缺少 rpId（站点域名，如 accounts.google.com）')
  const cfg = configOf(profileId)
  if (!cfg) throw new Error('该环境没有指纹配置')
  if (!cfg.enabled) throw new Error('该环境的指纹配置里已关闭 WebAuthn')

  const origin = input.origin?.trim() || `https://${rpId}`
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error(`origin 无法解析：${origin}`)
  }
  // rpId 必须是页面域名的注册域，否则内核直接拒绝注册
  const host = url.hostname
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw new Error(`rpId ${rpId} 与页面域名 ${host} 不匹配，内核会拒绝注册`)
  }

  await ensureRunning(profileId)

  const challenge = randomBytes(32).toString('base64')
  const userId = randomBytes(32).toString('base64')

  // 注册与「读私钥」必须在同一个认证器实例上完成：认证器是按页面挂载的，
  // 换一个页面就读不到刚生成的那把密钥。
  const { created, found } = await withDedicatedPage(
    profileId,
    url.href,
    async (page, state) => {
      const created = (await page.evaluate(pageFn(PAGE_CREATE), {
        challengeB64: challenge,
        userB64: userId,
        rpId,
        rpName: input.rpName ?? rpId,
        userName: input.userName ?? null
      })) as {
        error?: string
        credentialIdB64?: string
        attestationB64?: string
        transports?: string[]
        attachment?: string | null
      }
      if (created.error) throw new Error(`注册失败：${created.error}`)
      if (!created.attestationB64 || !created.credentialIdB64) throw new Error('注册未返回凭证')
      const creds = await readAttachedCredentials(state.cdp, state.authenticatorId)
      return { created, found: creds.find((c) => c.credentialId === created.credentialIdB64) }
    }
  )

  const parsed = parseAttestationObject(new Uint8Array(Buffer.from(created.attestationB64!, 'base64')))
  const expectedHash = rpIdHashHex(rpId)
  if (parsed.rpIdHash !== expectedHash) {
    throw new Error(`rpIdHash 不匹配：期望 ${expectedHash}，实际 ${parsed.rpIdHash}`)
  }
  const credentialId = created.credentialIdB64!

  // 私钥从认证器里读出（CDP 会回传），下次启动才能重新注入并继续签名
  if (!found) throw new Error(`认证器里找不到刚注册的凭证 ${credentialId.slice(0, 12)}…`)

  const primary = attached.get(profileId)
  if (primary) primary.observedAaguid = parsed.aaguid
  const saved = addCredential({
    profileId,
    rpId,
    rpName: input.rpName ?? rpId,
    userHandle: input.userHandle ?? found.userHandle,
    userName: input.userName ?? null,
    publicKey: parsed.publicKey ?? '',
    credentialId,
    privateKey: found.privateKey,
    signCount: parsed.signCount,
    isResidentCredential: true,
    aaguid: parsed.aaguid ?? cfg.aaguid,
    source: 'enroll',
    note: `fmt=${parsed.fmt} alg=${parsed.publicKeyAlgorithm ?? '?'} attachment=${created.attachment ?? '-'} transports=${(created.transports ?? []).join(',')}`
  })

  const mismatch = Boolean(parsed.aaguid) && parsed.aaguid !== cfg.aaguid
  log('webauthn', `已注册 passkey ${rpId}/${credentialId.slice(0, 12)}… aaguid=${parsed.aaguid}`)
  const algName = parsed.publicKeyAlgorithm === -257 ? 'RS256' : parsed.publicKeyAlgorithm === -7 ? 'ES256' : `alg:${parsed.publicKeyAlgorithm ?? '?'}`
  return {
    credentialId: saved.credentialId,
    rpId,
    aaguid: parsed.aaguid ?? cfg.aaguid,
    model: cfg.model,
    algorithm: algName,
    verified: true,
    message: mismatch
      ? `注册成功，但内核实际 AAGUID 为 ${parsed.aaguid}，与 profile 声明的 ${cfg.aaguid}（${cfg.model}）不一致：CDP 无法指定 AAGUID，它只在注册时出现，登录断言里不含`
      : `注册成功：${cfg.model}（${rpId}）`
  }
}

/** 用已保存的凭证做一次断言，验证「这台设备真的能登录」 */
export async function verify(
  profileId: string,
  credentialId: string,
  origin?: string
): Promise<{ ok: boolean; message: string; signCount: number | null }> {
  const cred = listCredentials(profileId).find((c) => c.credentialId === credentialId)
  if (!cred) return { ok: false, message: '凭证不存在', signCount: null }
  if (!cred.privateKey) return { ok: false, message: '缺少私钥，无法签名', signCount: null }

  await ensureRunning(profileId)
  const state = attached.get(profileId) ?? (await attachForProfile(profileId))
  if (!state) return { ok: false, message: '环境未运行且无法挂载认证器', signCount: null }

  const session = getSession(profileId)
  if (!session) return { ok: false, message: '环境未运行', signCount: null }

  const url = origin?.trim() || `https://${cred.rpId}/`
  const challenge = randomBytes(32).toString('base64')
  const page = await session.context.newPage()
  let out: { error?: string; signatureB64?: string; authDataB64?: string; matches?: boolean }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    out = (await page.evaluate(pageFn(PAGE_GET), { challengeB64: challenge, allowB64: cred.credentialId })) as typeof out
  } finally {
    await page.close().catch(() => undefined)
  }

  if (out.error) return { ok: false, message: `断言失败：${out.error}`, signCount: null }
  if (!out.matches) return { ok: false, message: '断言返回的 credential id 与保存的不一致', signCount: null }
  if (!out.signatureB64) return { ok: false, message: '断言缺少签名', signCount: null }

  let signCount: number | null = null
  try {
    const ad = parseAuthData(new Uint8Array(Buffer.from(out.authDataB64 ?? '', 'base64')))
    signCount = ad.signCount
    // 标志位必须与配置一致：UV 缺失说明没做用户验证（站点会降级），
    // BE/BS 不符说明换了一类设备（云同步 passkey vs 独立安全密钥）
    const cfg = configOf(profileId)
    const flags = ad.flags
    const bad: string[] = []
    if (!(flags & FLAG.UP)) bad.push('缺少 UP（用户在场）')
    if (cfg?.hasUserVerification && !(flags & FLAG.UV)) bad.push('缺少 UV（用户验证）')
    const be = Boolean(flags & FLAG.BE)
    const bs = Boolean(flags & FLAG.BS)
    if (be !== cfg?.isSynced) bad.push(`BE=${be ? 1 : 0}（配置 isSynced=${cfg?.isSynced ? 1 : 0}）`)
    if (cfg?.isSynced && !bs) bad.push('缺少 BS（云同步 passkey 应报告已备份）')
    if (flags & FLAG.AT) bad.push('断言里不应出现 AT（那是注册才有的标志）')
    if (bad.length) {
      return { ok: false, message: `断言签名有效，但标志位异常：${bad.join('；')} [${describeFlags(flags)}]`, signCount }
    }
  } catch (e) {
    // 解析失败绝不能报成功：signCount 与标志位是「这台设备还是不是原来那台」的唯一凭据，
    // 读不到就等于体检没做，静默通过会让凭证复制 / 设备类型变化都看不出来。
    const msg = e instanceof Error ? e.message : String(e)
    logError('webauthn', 'authData 解析失败', e)
    return { ok: false, message: `断言返回的 authData 无法解析：${msg}`, signCount: null }
  }
  touchCredential(cred.id, signCount ?? undefined)
  return { ok: true, message: `断言成功，signCount=${signCount ?? '?'}`, signCount }
}

/** 体检：库里的凭证与 profile 声明的认证器型号是否一致 */
export function issues(profileId: string): string[] {
  const cfg = configOf(profileId)
  if (!cfg) return []
  const out: string[] = []
  for (const c of listCredentials(profileId)) {
    if (c.aaguid !== cfg.aaguid) {
      out.push(`${c.rpId} 的 passkey AAGUID 是 ${c.aaguid}，与 profile 声明的 ${cfg.aaguid}（${cfg.model}）不一致`)
    }
    if (!c.privateKey) out.push(`${c.rpId} 的 passkey 缺少私钥，无法在新会话里重新签名`)
  }
  const state = attached.get(profileId)
  if (state && state.failed.length) out.push(`${state.failed.length} 个 passkey 注入失败：${state.failed[0].error}`)
  return out
}