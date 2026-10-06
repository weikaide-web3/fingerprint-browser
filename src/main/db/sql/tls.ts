/**
 * TLS / HTTP2 观测与基线。
 *
 * tls_observations 存每次实测到的 ClientHello / H2 形状（按环境），
 * tls_baselines 存「某个内核版本应该长什么样」，两者比对才能判断
 * 某个环境是不是偷偷换了内核或走了不同的出口链路。
 */
export const TLS_SQL = `
CREATE TABLE IF NOT EXISTS tls_observations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
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
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tls_obs_profile ON tls_observations(profile_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tls_obs_ja4 ON tls_observations(ja4);

CREATE TABLE IF NOT EXISTS tls_baselines (
  kernel_version TEXT PRIMARY KEY,
  chrome_major INTEGER NOT NULL,
  ja3 TEXT NOT NULL,
  ja4 TEXT NOT NULL,
  ja4r TEXT,
  h2fp TEXT,
  cipher_count INTEGER,
  ext_count INTEGER,
  grease_count INTEGER,
  samples INTEGER NOT NULL DEFAULT 1,
  observed_at INTEGER NOT NULL
);
`

/**
 * Chrome 每次连接都会随机 GREASE 值，原始 JA3 因此跨连接必然不同。
 * 基线比对改用「去掉 GREASE 的 JA3」，否则每次探测都会误报成换了内核。
 */
export const TLS_STABLE_SQL = `
ALTER TABLE tls_observations ADD COLUMN ja3_stable TEXT;
ALTER TABLE tls_baselines ADD COLUMN ja3_stable TEXT;
CREATE INDEX IF NOT EXISTS idx_tls_obs_ja3s ON tls_observations(ja3_stable);
`

/**
 * Chrome 110+ 会随机打乱 TLS 扩展顺序，所以「去掉 GREASE 的 JA3」仍然每次不同。
 * 真正跨连接可比的是「去 GREASE 且排序」后的 JA3，以及扩展的线上顺序本身
 * （两次观测顺序不同 = 客户端在打乱，这是真 Chrome 的行为特征，值得单独存）。
 */
export const TLS_SORTED_SQL = `
ALTER TABLE tls_observations ADD COLUMN ja3_sorted TEXT;
ALTER TABLE tls_observations ADD COLUMN ext_order TEXT;
ALTER TABLE tls_baselines ADD COLUMN ja3_sorted TEXT;
CREATE INDEX IF NOT EXISTS idx_tls_obs_ja3sort ON tls_observations(ja3_sorted);
`