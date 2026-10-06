import { log, logError } from '../lib/log'
import type { WebAuthnConfig } from '@shared/webauthn'

/**
 * CDP WebAuthn 虚拟认证器的挂载与凭证注入。
 *
 * 已实测确认（见 tests/integration/webauthn-live.test.ts）：
 *  - addVirtualAuthenticator **没有 aaguid 参数**，内核会为每个认证器实例随机生成；
 *  - getCredentials 会返回 ECDSA P-256 私钥（PKCS#8），因此可以完整持久化后重新注入；
 *  - 所以「同一环境每次都被认成同一把 passkey」只能靠 credentialId + 私钥复用，
 *    AAGUID 只在注册那一刻出现，登录断言里不含 AAGUID。
 */

/**
 * 只声明我们用到的那部分 CDP 能力。
 * 不用 playwright 的 Protocol.* 类型：它没有从包入口导出，且 send 的泛型签名
 * 与这里的动态方法名不兼容；本地类型也让参数形状与实测保持一致。
 */
export type Cdp = { send(method: string, params?: object): Promise<unknown> }

export interface CdpAuthenticatorOptions {
  protocol: 'ctap1' | 'ctap2'
  ctap2Version?: 'ctap2' | 'ctap2_1'
  transport: 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid' | 'smart-card'
  hasResidentKey: boolean
  hasUserVerification: boolean
  isUserVerified?: boolean
  hasLargeBlob?: boolean
  hasCredBlob?: boolean
  hasPrf?: boolean
  automaticPresenceSimulation?: boolean
  defaultBackupEligibility?: boolean
  defaultBackupState?: boolean
}

export interface CdpCredential {
  credentialId: string
  isResidentCredential: boolean
  rpId?: string
  privateKey: string
  userHandle?: string
  signCount: number
  largeBlob?: string
  backupEligibility?: boolean
  backupState?: boolean
  credBlob?: string
  userName?: string
  userDisplayName?: string
}

export interface AttachedCredential {
  credentialId: string
  rpId: string
  userHandle: string | null
  publicKeyish: string
  privateKey: string
  signCount: number
  isResidentCredential: boolean
}

/** 把指纹配置映射成 CDP 的虚拟认证器参数 */
export function toCdpOptions(cfg: WebAuthnConfig): CdpAuthenticatorOptions {
  return {
    protocol: 'ctap2',
    // ctap2_1 起才有 largeBlob / credProtect 的完整语义，真实设备现在基本都是 2.1+
    ctap2Version: 'ctap2_1',
    transport: cfg.transport,
    hasResidentKey: cfg.hasResidentKey,
    hasUserVerification: cfg.hasUserVerification,
    hasLargeBlob: cfg.supportsLargeBlob,
    hasCredBlob: true,
    hasPrf: true,
    // 平台认证器不会弹「请插入密钥」，直接视为已确认存在
    automaticPresenceSimulation: true,
    isUserVerified: cfg.hasUserVerification,
    // 平台 passkey（Apple/Google 账号里的）是云同步的：BE/BS 都为真；
    // 漫游密钥（YubiKey）不可备份，两者都为假。站点会读这两个标志位判断设备类型。
    defaultBackupEligibility: cfg.isSynced,
    defaultBackupState: cfg.isSynced
  }
}

export async function enableWebAuthn(cdp: Cdp): Promise<boolean> {
  try {
    await cdp.send('WebAuthn.enable')
    return true
  } catch (e) {
    logError('webauthn', 'WebAuthn.enable 失败（内核可能不支持该 CDP 域）', e)
    return false
  }
}

export async function addVirtualAuthenticator(cdp: Cdp, cfg: WebAuthnConfig): Promise<string | null> {
  try {
    const res = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: toCdpOptions(cfg)
    })) as { authenticatorId: string }
    log('webauthn', `已挂载虚拟认证器 ${res.authenticatorId} aaguid(期望)=${cfg.aaguid} model=${cfg.model}`)
    return res.authenticatorId
  } catch (e) {
    logError('webauthn', 'addVirtualAuthenticator 失败', e)
    return null
  }
}

export async function removeVirtualAuthenticator(cdp: Cdp, authenticatorId: string): Promise<void> {
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined)
}

/** 把库里保存的凭证重新注入认证器，让站点认为这台设备上有这些 passkey */
export async function injectCredentials(
  cdp: Cdp,
  authenticatorId: string,
  creds: {
    credentialId: string
    rpId: string
    privateKey: string
    userHandle?: string | null
    userName?: string | null
    signCount: number
    isResidentCredential: boolean
    isSynced: boolean
  }[]
): Promise<{ injected: number; failed: { credentialId: string; error: string }[] }> {
  const failed: { credentialId: string; error: string }[] = []
  let injected = 0
  for (const c of creds) {
    if (!c.privateKey) {
      failed.push({ credentialId: c.credentialId, error: '缺少私钥，无法重新签名' })
      continue
    }
    try {
      await cdp.send('WebAuthn.addCredential', {
        authenticatorId,
        credential: {
          credentialId: c.credentialId,
          isResidentCredential: c.isResidentCredential,
          rpId: c.rpId,
          privateKey: c.privateKey,
          userHandle: c.userHandle ?? undefined,
          signCount: c.signCount,
          backupEligibility: c.isSynced,
          backupState: c.isSynced,
          userName: c.userName ?? undefined,
          userDisplayName: c.userName ?? undefined
        }
      })
      injected += 1
    } catch (e) {
      failed.push({ credentialId: c.credentialId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (injected) log('webauthn', `已重新注入 ${injected} 个 passkey 凭证`)
  for (const f of failed) log('webauthn', `凭证 ${f.credentialId.slice(0, 12)}… 注入失败：${f.error}`)
  return { injected, failed }
}

/** 读取认证器里实际存在的凭证（含私钥，用于持久化） */
export async function readAttachedCredentials(cdp: Cdp, authenticatorId: string): Promise<AttachedCredential[]> {
  try {
    const res = (await cdp.send('WebAuthn.getCredentials', {
      authenticatorId
    })) as { credentials?: CdpCredential[] }
    return (res.credentials ?? []).map((c) => ({
      credentialId: c.credentialId,
      rpId: c.rpId ?? '',
      userHandle: c.userHandle ?? null,
      // CDP 不直接回传 COSE 公钥；注册时我们从 attestationObject 里解析后自行保存
      publicKeyish: '',
      privateKey: c.privateKey,
      signCount: c.signCount,
      isResidentCredential: c.isResidentCredential
    }))
  } catch (e) {
    logError('webauthn', 'getCredentials 失败', e)
    return []
  }
}