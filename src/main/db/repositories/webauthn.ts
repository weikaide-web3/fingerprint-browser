import { getDb } from '../index'
import { newId, now } from '../../lib/id'
import { encryptSecret, decryptSecret } from '../../lib/crypto'
import type { WebAuthnCredential } from '@shared/webauthn'

/**
 * webauthn_credentials 仓储。
 *
 * private_key 是虚拟认证器用来签 assertion 的密钥，必须加密落盘：
 * 拿到它 + credentialId 就等于拿到这台设备的 passkey 能力。
 * 仓储层负责加解密，上层只看到明文瞬时值（且只在主进程内）。
 */

interface Row {
  id: string
  profile_id: string
  rp_id: string
  rp_name: string | null
  user_handle: string | null
  user_name: string | null
  public_key: string
  credential_id: string
  private_key: string
  sign_count: number
  is_resident: number
  aaguid: string
  source: string
  note: string | null
  created_at: number
  last_used_at: number | null
}

function mapRow(r: Row): WebAuthnCredential {
  return {
    id: r.id,
    profileId: r.profile_id,
    rpId: r.rp_id,
    rpName: r.rp_name,
    userHandle: r.user_handle,
    userName: r.user_name,
    publicKey: r.public_key,
    credentialId: r.credential_id,
    privateKey: decryptSecret(r.private_key) ?? '',
    signCount: r.sign_count,
    isResidentCredential: r.is_resident === 1,
    aaguid: r.aaguid,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    source: (r.source as WebAuthnCredential['source']) ?? 'enroll',
    note: r.note
  }
}

export interface NewCredential {
  profileId: string
  rpId: string
  rpName?: string | null
  userHandle?: string | null
  userName?: string | null
  publicKey: string
  credentialId: string
  privateKey: string
  signCount?: number
  isResidentCredential?: boolean
  aaguid: string
  source?: WebAuthnCredential['source']
  note?: string | null
}

export function listCredentials(profileId: string): WebAuthnCredential[] {
  const rows = getDb()
    .prepare('SELECT * FROM webauthn_credentials WHERE profile_id = ? ORDER BY created_at DESC')
    .all(profileId) as Row[]
  return rows.map(mapRow)
}

export function countCredentials(profileId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE profile_id = ?')
    .get(profileId) as { n: number }
  return row.n
}

export function countAllCredentials(): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT profile_id AS profileId, COUNT(*) AS n FROM webauthn_credentials GROUP BY profile_id')
    .all() as { profileId: string; n: number }[]
  return new Map(rows.map((r) => [r.profileId, r.n]))
}

export function getCredential(id: string): WebAuthnCredential | null {
  const row = getDb().prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(id) as Row | undefined
  return row ? mapRow(row) : null
}

export function findCredential(profileId: string, rpId: string, credentialId: string): WebAuthnCredential | null {
  const row = getDb()
    .prepare('SELECT * FROM webauthn_credentials WHERE profile_id = ? AND rp_id = ? AND credential_id = ?')
    .get(profileId, rpId, credentialId) as Row | undefined
  return row ? mapRow(row) : null
}

export function addCredential(input: NewCredential): WebAuthnCredential {
  const id = newId('wa')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO webauthn_credentials
        (id, profile_id, rp_id, rp_name, user_handle, user_name, public_key, credential_id,
         private_key, sign_count, is_resident, aaguid, source, note, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.profileId,
      input.rpId,
      input.rpName ?? null,
      input.userHandle ?? null,
      input.userName ?? null,
      input.publicKey,
      input.credentialId,
      encryptSecret(input.privateKey),
      input.signCount ?? 0,
      input.isResidentCredential === false ? 0 : 1,
      input.aaguid,
      input.source ?? 'enroll',
      input.note ?? null,
      ts,
      null
    )
  return getCredential(id) as WebAuthnCredential
}

export function touchCredential(id: string, signCount?: number): void {
  getDb()
    .prepare(
      `UPDATE webauthn_credentials
         SET last_used_at = ?, sign_count = COALESCE(?, sign_count + 1)
       WHERE id = ?`
    )
    .run(now(), signCount ?? null, id)
}

export function removeCredential(id: string): boolean {
  return getDb().prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id).changes > 0
}

export function removeProfileCredentials(profileId: string): number {
  return getDb().prepare('DELETE FROM webauthn_credentials WHERE profile_id = ?').run(profileId).changes
}