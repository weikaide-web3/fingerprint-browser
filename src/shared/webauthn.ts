/**
 * WebAuthn / Passkey 的共用契约。
 *
 * 为什么必须实现：Google 与 X 现在对新设备优先推 passkey。
 * 没有可注册的认证器，新设备登录就会被降级到手机/邮箱验证 ——
 * 而「需要手机验证」本身就是风控信号（说明这台设备不被信任）。
 *
 * 实现方式：CDP 的 WebAuthn 域提供一个虚拟认证器，密钥对由内核生成并保管，
 * 我们只持久化「凭证元数据 + 公钥/credential id」，用于跨重启重新注入。
 * 私钥不离开内核，这一点与真实 passkey 的行为一致。
 */

export type WebAuthnTransport = 'internal' | 'usb' | 'nfc' | 'ble' | 'hybrid'

/** 每个环境的虚拟认证器参数（决定站点看到的 aaguid / 认证器模型） */
export interface WebAuthnConfig {
  enabled: boolean
  /** 认证器唯一标识：同一环境必须稳定，否则每次都被认成新安全密钥 */
  aaguid: string
  /** 站点在「已注册密钥」列表里看到的名字 */
  model: string
  /** internal = 平台认证器（Touch ID / Windows Hello）；usb 等 = 漫游密钥 */
  transport: WebAuthnTransport
  /** resident key = 可发现凭证，passkey 登录流程必需 */
  hasResidentKey: boolean
  /** 用户验证：true 时站点会要求生物识别/ PIN，虚拟认证器会直接通过 */
  hasUserVerification: boolean
  /** 是否走云同步（Google 的 passkey 就是 synced 的，会影响 isBackupEligible） */
  isSynced: boolean
  /** 大 blob 扩展（Google 用 large-blob 做无 UI 登录） */
  supportsLargeBlob: boolean
  /** 强 PIN / 生物识别信号（credProtect level 1-3） */
  credProtect: 1 | 2 | 3
}

/** 已注册凭证：跨重启重新注入，让站点认为「这台设备上有这个 passkey」 */
export interface WebAuthnCredential {
  id: string
  profileId: string
  rpId: string
  /** 站点展示名（Google / X） */
  rpName: string | null
  userHandle: string | null
  userName: string | null
  /** base64(COSE 公钥)：虚拟认证器不导出私钥，公钥用于重新注册时保持一致 */
  publicKey: string
  /** base64(credential id) */
  credentialId: string
  signCount: number
  isResidentCredential: boolean
  /** base64 的 U2F 私钥（PKCS8/DER）。CDP 的 addCredential 需要它才能重新签名 */
  privateKey: string
  aaguid: string
  createdAt: number
  lastUsedAt: number | null
  /** 由谁登记：手动注册 / RPA 流程 / 从其它设备迁移 */
  source: 'enroll' | 'rpa' | 'import'
  note: string | null
}

/**
 * 给界面用的凭证视图：**不含私钥**。
 *
 * WebAuthnCredential 带 privateKey，因为主进程要用它重新注入认证器。
 * 但私钥 + credentialId 就等于这台设备的 passkey 能力，
 * 绝不能进渲染进程 —— 渲染进程是应用里最容易被站点脚本波及的一侧。
 * 界面只需要知道「有没有私钥」来判断这条 passkey 还能不能用。
 */
export interface WebAuthnCredentialView {
  id: string
  profileId: string
  rpId: string
  rpName: string | null
  userHandle: string | null
  userName: string | null
  publicKey: string
  credentialId: string
  signCount: number
  isResidentCredential: boolean
  /** 私钥是否可解密。false = 这条 passkey 已失效，需要重新注册 */
  hasPrivateKey: boolean
  aaguid: string
  createdAt: number
  lastUsedAt: number | null
  source: 'enroll' | 'rpa' | 'import'
  note: string | null
}

/** 注册结果（给 UI 展示） */
export interface WebAuthnEnrollResult {
  credentialId: string
  rpId: string
  aaguid: string
  model: string
  algorithm: string
  /** 内核里是否真的完成了注册 */
  verified: boolean
  message: string
}

export interface WebAuthnStatus {
  profileId: string
  /** 当前运行会话里是否已挂载虚拟认证器 */
  attached: boolean
  authenticatorId: string | null
  configured: WebAuthnConfig | null
  credentials: number
  /** 已挂载认证器里实际存在的凭证数（与库里数量不一致说明注入失败） */
  attachedCredentials: number
  issues: string[]
}