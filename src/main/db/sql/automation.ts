export const AUTOMATION_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  platform        TEXT,
  username        TEXT,
  password_enc    TEXT,
  totp_secret_enc TEXT,
  email           TEXT,
  phone           TEXT,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS extensions (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  version    TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_extensions (
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, extension_id)
);

CREATE TABLE IF NOT EXISTS rpa_flows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  graph       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rpa_runs (
  id          TEXT PRIMARY KEY,
  flow_id     TEXT REFERENCES rpa_flows(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  log_path    TEXT,
  stats       TEXT
);
CREATE TABLE IF NOT EXISTS rpa_schedules (
  id          TEXT PRIMARY KEY,
  flow_id     TEXT NOT NULL REFERENCES rpa_flows(id) ON DELETE CASCADE,
  cron        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  params      TEXT,
  next_run_at INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  id         TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'use',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'local',
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);

CREATE TABLE IF NOT EXISTS usage_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  action     TEXT NOT NULL,
  ip         TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_profile ON usage_logs(profile_id, ts DESC);
`
