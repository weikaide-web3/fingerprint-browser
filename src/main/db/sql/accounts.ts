/**
 * accounts 表的补强迁移。
 *
 * 原表只有基础字段，缺三样东西：
 * - last_used_at：账号信誉与「同 IP 账号数」判定都要看最近使用时间；
 * - totp_kind：区分 TOTP / 短信 / 无。短信无法自动填充，必须让上层知道；
 * - created_profile_id：账号在哪个环境注册的。换环境登录 = 服务端看到
 *   「同一账号在两台设备出现」，这是最常见的连坐原因，所以要留痕可比对。
 */
export const ACCOUNTS_SQL = `
ALTER TABLE accounts ADD COLUMN last_used_at INTEGER;
ALTER TABLE accounts ADD COLUMN totp_kind TEXT NOT NULL DEFAULT 'none';
ALTER TABLE accounts ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN created_profile_id TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_profile ON accounts(profile_id);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);
`
