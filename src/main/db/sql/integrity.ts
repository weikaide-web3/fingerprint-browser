/**
 * 引用完整性与保留策略（M2 补强）。
 *
 * 修三件事：
 *
 * 1. webauthn_credentials / tls_observations 的 profile_id 原本没有外键。
 *    彻底删除环境（purgeProfile）只 DELETE profiles 行，于是 passkey 私钥与
 *    TLS 观测永久残留：既占空间，也是「环境已删但凭据还在」的隐私问题。
 *    SQLite 不能 ALTER TABLE ADD FOREIGN KEY，只能重建表。
 *
 * 2. tags 表原本只由「新建标签」写入，而给环境打标签只写 profile_tags。
 *    结果 TAG_LIST 返回的清单与界面实际在用的标签脱节。这里把已存在的
 *    标签名回填进 tags，之后由仓储层保证两边同步。
 *
 * 3. audit_logs / usage_logs / rpa_runs 没有任何保留上限，长期跑会无限增长。
 *    加一个索引让按时间清理廉价（清理逻辑在 repositories/retention.ts）。
 */
export const INTEGRITY_SQL = `
-- ---------- 1. webauthn_credentials 加外键 ----------
-- 先清掉孤儿行，否则重建后插入会直接违反外键约束
DELETE FROM webauthn_credentials
 WHERE profile_id NOT IN (SELECT id FROM profiles);

CREATE TABLE webauthn_credentials_new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
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
INSERT INTO webauthn_credentials_new
  SELECT id, profile_id, rp_id, rp_name, user_handle, user_name, public_key,
         credential_id, private_key, sign_count, is_resident, aaguid, source,
         note, created_at, last_used_at
  FROM webauthn_credentials;
DROP TABLE webauthn_credentials;
ALTER TABLE webauthn_credentials_new RENAME TO webauthn_credentials;
CREATE INDEX IF NOT EXISTS idx_webauthn_profile ON webauthn_credentials(profile_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_rp ON webauthn_credentials(rp_id);

-- ---------- 2. tls_observations 加外键 ----------
DELETE FROM tls_observations
 WHERE profile_id NOT IN (SELECT id FROM profiles);

CREATE TABLE tls_observations_new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  proxy_id TEXT,
  host TEXT NOT NULL,
  via TEXT NOT NULL,
  ja3 TEXT NOT NULL,
  ja4 TEXT NOT NULL,
  ja4r TEXT,
  h2fp TEXT,
  version_label TEXT,
  alpn TEXT,
  cipher_count INTEGER,
  ext_count INTEGER,
  grease_count INTEGER,
  kernel_version TEXT,
  observed_at INTEGER NOT NULL,
  ja3_stable TEXT,
  ja3_sorted TEXT,
  ext_order TEXT
);
INSERT INTO tls_observations_new
  SELECT id, profile_id, proxy_id, host, via, ja3, ja4, ja4r, h2fp, version_label,
         alpn, cipher_count, ext_count, grease_count, kernel_version, observed_at,
         ja3_stable, ja3_sorted, ext_order
  FROM tls_observations;
DROP TABLE tls_observations;
ALTER TABLE tls_observations_new RENAME TO tls_observations;
CREATE INDEX IF NOT EXISTS idx_tls_obs_profile ON tls_observations(profile_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tls_obs_ja4 ON tls_observations(ja4);
CREATE INDEX IF NOT EXISTS idx_tls_obs_ja3s ON tls_observations(ja3_stable);
CREATE INDEX IF NOT EXISTS idx_tls_obs_ja3sort ON tls_observations(ja3_sorted);

-- ---------- 3. accounts.created_profile_id 查询索引（关联分析按它分组） ----------
CREATE INDEX IF NOT EXISTS idx_accounts_created_profile ON accounts(created_profile_id);

-- ---------- 4. tags 回填：让标签清单与实际在用的标签一致 ----------
INSERT OR IGNORE INTO tags (id, name, color, created_at)
  SELECT 'tg_' || lower(hex(randomblob(10))), pt.tag, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM (SELECT DISTINCT tag FROM profile_tags) pt
  WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.name = pt.tag);

-- ---------- 5. 日志保留所需索引 ----------
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_rpa_runs_started ON rpa_runs(started_at DESC);

-- ---------- 6. 移除从未被读过的表 ----------
-- proxy_groups：建了但全项目零引用（代理分组实际用的是 groups 表）。
-- api_keys：设计给「多 Token / 可撤销」，但实际鉴权走 settings 里的单个 apiToken，
--           这张表从未写入过，留着只会让人以为已经支持多 Key。
-- 两张表都是空的，DROP 不丢任何用户数据。
DROP TABLE IF EXISTS proxy_groups;
DROP TABLE IF EXISTS api_keys;
`
