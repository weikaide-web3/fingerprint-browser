import { getDb } from '../index'
import { newId, now } from '../../lib/id'
import { encryptSecret, decryptSecret } from '../../lib/crypto'
import { isValidBase32, normalizeTotpSecret, parseOtpauthUri } from '../../totp'
import type { AccountInput, AccountPlatform, AccountRecord } from '@shared/account'

/**
 * accounts 仓储。
 *
 * 机密（密码 / TOTP 密钥）一律加密落库，读列表时**绝不解密**：
 * 渲染进程只拿到 hasPassword / hasTotp 这样的布尔量。
 * 只有主进程在真正要填充表单时才解密，且用完即弃 —— 这样即使渲染进程
 * 被站点脚本攻破（X / Google 的登录页本身就是攻击面），也偷不到凭据。
 */

interface AccountRow {
  id: string
  profile_id: string | null
  platform: string
  username: string
  password_enc: string | null
  totp_secret_enc: string | null
  email: string | null
  phone: string | null
  note: string | null
  last_used_at: number | null
  totp_kind: string
  login_count: number
  created_profile_id: string | null
  created_at: number
  updated_at: number
}

function mapRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    platform: row.platform as AccountPlatform,
    username: row.username,
    email: row.email,
    phone: row.phone,
    note: row.note,
    hasPassword: Boolean(row.password_enc),
    hasTotp: Boolean(row.totp_secret_enc),
    totpKind: (row.totp_kind ?? 'none') as AccountRecord['totpKind'],
    createdProfileId: row.created_profile_id,
    loginCount: row.login_count ?? 0,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 判定 2FA 类型：有密钥=TOTP，只有手机号=短信（无法自动），都没有=无 */
function detectTotpKind(input: Partial<AccountInput>, existing?: AccountRow): AccountRecord['totpKind'] {
  if (input.totpSecret !== undefined) return input.totpSecret ? 'totp' : input.phone ? 'sms' : 'none'
  if (existing?.totp_secret_enc) return 'totp'
  const phone = input.phone !== undefined ? input.phone : existing?.phone
  return phone ? 'sms' : 'none'
}

/** 密钥可以是裸 Base32，也可以是 otpauth:// URI（验证器导出的格式） */
export function resolveTotpSecret(input: string): { secret: string; label?: string } {
  const uri = parseOtpauthUri(input)
  if (uri) return { secret: uri.secret, label: uri.label }
  const bare = normalizeTotpSecret(input)
  if (!isValidBase32(bare)) throw new Error('TOTP 密钥无效：需要 Base32（A-Z / 2-7）或 otpauth:// 链接')
  return { secret: bare }
}

export function listAccounts(profileId?: string): AccountRecord[] {
  const rows = (
    profileId
      ? getDb().prepare('SELECT * FROM accounts WHERE profile_id = ? ORDER BY created_at DESC').all(profileId)
      : getDb().prepare('SELECT * FROM accounts ORDER BY created_at DESC').all()
  ) as AccountRow[]
  return rows.map(mapRow)
}

export function getAccount(id: string): AccountRecord | null {
  const row = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
  return row ? mapRow(row) : null
}

/** 同平台 + 同用户名的重复检查：重复录入意味着两个环境会用同一账号登录 */
export function findDuplicate(platform: AccountPlatform, username: string, exceptId?: string): AccountRecord | null {
  const rows = getDb().prepare('SELECT * FROM accounts WHERE platform = ? AND username = ?').all(platform, username) as AccountRow[]
  const hit = rows.find((r) => r.id !== exceptId)
  return hit ? mapRow(hit) : null
}

export function createAccount(input: AccountInput): AccountRecord {
  const username = String(input.username ?? '').trim()
  if (!username) throw new Error('账号用户名不能为空')
  const dup = findDuplicate(input.platform, username)
  if (dup) throw new Error(`该账号已存在（${dup.username} @ ${dup.platform}）`)
  const id = newId('ac')
  const ts = now()
  const totp = input.totpSecret ? resolveTotpSecret(input.totpSecret) : null
  getDb()
    .prepare(
      `INSERT INTO accounts
        (id, profile_id, platform, username, password_enc, totp_secret_enc, email, phone, note,
         created_at, updated_at, totp_kind, created_profile_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.profileId ?? null,
      input.platform,
      username,
      encryptSecret(input.password ?? null),
      encryptSecret(totp?.secret ?? null),
      input.email ?? null,
      input.phone ?? null,
      input.note ?? null,
      ts,
      ts,
      detectTotpKind(input),
      input.profileId ?? null
    )
  return getAccount(id) as AccountRecord
}

export function updateAccount(id: string, patch: Partial<AccountInput>): AccountRecord | null {
  const existing = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
  if (!existing) return null
  const fields: string[] = []
  const values: unknown[] = []
  const push = (col: string, val: unknown): void => {
    fields.push(`${col} = ?`)
    values.push(val)
  }
  if (patch.profileId !== undefined) push('profile_id', patch.profileId)
  if (patch.platform !== undefined) push('platform', patch.platform)
  if (patch.username !== undefined) {
    const username = String(patch.username).trim()
    if (!username) throw new Error('账号用户名不能为空')
    push('username', username)
  }
  if (patch.email !== undefined) push('email', patch.email)
  if (patch.phone !== undefined) push('phone', patch.phone)
  if (patch.note !== undefined) push('note', patch.note)
  // 传 null / '' 表示清除，不传表示保持
  if (patch.password !== undefined) push('password_enc', encryptSecret(patch.password || null))
  if (patch.totpSecret !== undefined) {
    const totp = patch.totpSecret ? resolveTotpSecret(patch.totpSecret) : null
    push('totp_secret_enc', encryptSecret(totp?.secret ?? null))
  }
  push('totp_kind', detectTotpKind(patch, existing))
  push('updated_at', now())
  values.push(id)
  getDb().prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getAccount(id)
}

export function deleteAccount(id: string): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

/** 只在主进程内使用：解密后的机密，调用方用完即弃 */
export function getAccountSecrets(id: string): { password: string | null; totpSecret: string | null } | null {
  const row = getDb().prepare('SELECT password_enc, totp_secret_enc FROM accounts WHERE id = ?').get(id) as
    | { password_enc: string | null; totp_secret_enc: string | null }
    | undefined
  if (!row) return null
  return { password: decryptSecret(row.password_enc), totpSecret: decryptSecret(row.totp_secret_enc) }
}

export function touchAccount(id: string): void {
  getDb().prepare('UPDATE accounts SET last_used_at = ?, login_count = login_count + 1 WHERE id = ?').run(now(), id)
}

/** 每个环境绑定了哪些账号：关联隔离判定要用 */
export function accountCountByProfile(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT profile_id AS profileId, COUNT(*) AS n FROM accounts WHERE profile_id IS NOT NULL GROUP BY profile_id')
    .all() as { profileId: string; n: number }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[r.profileId] = r.n
  return out
}

/**
 * 同一账号被绑到多少个环境。
 * 大于 1 就是「同账号多设备」：即使两个环境指纹都完美，服务端看到的也是
 * 同一账号在两台设备上交替出现 —— 这是最常见的封号原因之一。
 */
export function accountProfileConflicts(): { key: string; username: string; platform: string; profileIds: string[] }[] {
  const rows = getDb()
    .prepare('SELECT id, username, platform, profile_id FROM accounts WHERE profile_id IS NOT NULL')
    .all() as { id: string; username: string; platform: string; profile_id: string }[]
  const byAccount = new Map<string, { username: string; platform: string; profileIds: string[] }>()
  for (const r of rows) {
    const key = `${r.platform}|${r.username}`
    const cur = byAccount.get(key) ?? { username: r.username, platform: r.platform, profileIds: [] }
    cur.profileIds.push(r.profile_id)
    byAccount.set(key, cur)
  }
  return [...byAccount.entries()]
    .filter(([, v]) => v.profileIds.length > 1)
    .map(([key, v]) => ({ key, username: v.username, platform: v.platform, profileIds: v.profileIds }))
}