/**
 * WebAuthn 凭证表。
 *
 * 虚拟认证器的密钥在内核退出后就没了，但站点侧的注册关系还在。
 * 所以必须把 credentialId + 私钥 + 公钥存下来，下次启动时通过
 * WebAuthn.addCredential 重新注入 —— 否则同一个环境每次登录都会
 * 被 Google / X 认成「这台设备没有 passkey」，进而降级到手机验证。
 */
export const WEBAUTHN_SQL = `
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  rp_name TEXT,
  user_handle TEXT,
  user_name TEXT,
  public_key TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  private_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  is_resident INTEGER NOT NULL DEFAULT 1,
  aaguid TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'enroll',
  note TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (profile_id, rp_id, credential_id)
);

CREATE INDEX IF NOT EXISTS idx_webauthn_profile ON webauthn_credentials(profile_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_rp ON webauthn_credentials(rp_id);
`