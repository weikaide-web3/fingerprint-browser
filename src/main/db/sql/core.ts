export const CORE_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  type       TEXT NOT NULL DEFAULT 'string',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proxies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  scheme          TEXT NOT NULL,
  host            TEXT NOT NULL,
  port            INTEGER NOT NULL,
  username        TEXT,
  password_enc    TEXT,
  group_id        TEXT,
  ip              TEXT,
  country         TEXT,
  region          TEXT,
  city            TEXT,
  isp             TEXT,
  timezone        TEXT,
  latency_ms      INTEGER,
  last_checked_at INTEGER,
  checked_ok      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxies_group ON proxies(group_id);

CREATE TABLE IF NOT EXISTS proxy_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  group_id         TEXT REFERENCES groups(id) ON DELETE SET NULL,
  color            TEXT,
  icon             TEXT,
  note             TEXT,
  kernel           TEXT NOT NULL DEFAULT 'chromium',
  fingerprint_mode TEXT NOT NULL DEFAULT 'auto',
  proxy_mode       TEXT NOT NULL DEFAULT 'bind',
  proxy_id         TEXT REFERENCES proxies(id) ON DELETE SET NULL,
  user_data_dir    TEXT NOT NULL,
  startup_urls     TEXT NOT NULL DEFAULT '[]',
  launch_args      TEXT NOT NULL DEFAULT '[]',
  archived         INTEGER NOT NULL DEFAULT 0,
  open_count       INTEGER NOT NULL DEFAULT 0,
  last_opened_at   INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id);
CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at DESC);

CREATE TABLE IF NOT EXISTS fingerprints (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  config       TEXT NOT NULL,
  seed         TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_tags (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (profile_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_profile_tags_tag ON profile_tags(tag);

CREATE TABLE IF NOT EXISTS sessions_meta (
  profile_id         TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  cookie_count       INTEGER NOT NULL DEFAULT 0,
  storage_state_path TEXT,
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);
`
