import { app, safeStorage } from 'electron'
// 静态导入而不是动态 require 内部模块：electron-vite 会把主进程打成一个 bundle，
// 里面的相对路径 require 原样保留到 out/main/index.js，运行时按 out/main/ 解析
// 根本不存在这个文件，于是整个函数进 catch 返回 false —— 明文告警永远不会触发。
// db/index 只依赖 migrations，不反向依赖 lib，因此没有循环；
// better-sqlite3 本身在 openDatabase() 里懒加载，纯 Node 工具链导入本模块也不会崩。
import { getDb, isDbReady } from '../db'

/**
 * 机密字段加密：优先使用 macOS Keychain（Electron safeStorage），
 * 不可用时降级为带标记的明文，便于后续迁移到强加密。
 *
 * 降级必须被**显式暴露**：账号密码、代理密码、passkey 私钥都会以 plain: 前缀
 * 明文落库，而用户完全看不出来。之前这个状态是静默的 ——
 * 用户以为凭据是加密的，实际拿到 app.db 就能直接读走全部凭据。
 */
const PLAIN_PREFIX = 'plain:'

export function encryptionAvailable(): boolean {
  try {
    return app.isReady() ? safeStorage.isEncryptionAvailable() : safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 库里是否已经存在明文机密（plain: 前缀）。
 * 用于启动时告警：即使现在加密可用，历史数据可能仍是在加密不可用时写入的。
 */
export function hasPlaintextSecrets(): boolean {
  try {
    if (!isDbReady()) return false
    const db = getDb()
    // 语句逐条写死：不拼表名/列名，静态检查才能证明没有注入面
    const queries = [
      "SELECT COUNT(*) AS c FROM proxies WHERE password_enc LIKE 'plain:%'",
      "SELECT COUNT(*) AS c FROM accounts WHERE password_enc LIKE 'plain:%'",
      "SELECT COUNT(*) AS c FROM accounts WHERE totp_secret_enc LIKE 'plain:%'",
      "SELECT COUNT(*) AS c FROM webauthn_credentials WHERE private_key LIKE 'plain:%'"
    ]
    for (const sql of queries) {
      const row = db.prepare(sql).get() as { c: number }
      if (row.c > 0) return true
    }
    return false
  } catch {
    return false
  }
}

/** 加密状态摘要，给界面横幅与设置页用 */
export function encryptionStatus(): {
  available: boolean
  plaintextStored: boolean
  /** 人类可读结论，界面直接展示 */
  message: string | null
} {
  const available = encryptionAvailable()
  const plaintextStored = hasPlaintextSecrets()
  let message: string | null = null
  if (!available) {
    message = '系统钥匙串不可用：账号密码、代理密码、passkey 私钥正以明文存放在数据库里。'
  } else if (plaintextStored) {
    message = '数据库中仍有明文存放的机密（早期钥匙串不可用时写入）。重新保存这些条目即可改为加密存储。'
  }
  return { available, plaintextStored, message }
}

export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null
  if (!encryptionAvailable()) return PLAIN_PREFIX + plain
  return 'enc:' + safeStorage.encryptString(plain).toString('base64')
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
  if (!stored.startsWith('enc:') || !encryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  } catch {
    return null
  }
}

export function hashToken(value: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(value).digest('hex')
}
