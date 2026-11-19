-- Cloud Backup, Passwordless Email OTP Auth, and Invite/Church License Tables

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  plan_type TEXT NOT NULL DEFAULT 'personal',
  church_name TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  note TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  license_code TEXT,
  license_type TEXT,
  church_name TEXT,
  license_expires_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  pending_invite_code TEXT,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_email_created
  ON auth_codes(email, created_at);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS user_backups (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  data_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 初期シード：新発田いのちのパンチャーチ用教会ライセンス ＆ 初期買い切りコード枠
INSERT OR IGNORE INTO invite_codes (code, plan_type, church_name, max_uses, used_count, expires_at, note, is_active, created_at)
VALUES
  ('SHIBATA-CHURCH', 'church', '新発田いのちのパンチャーチ', 300, 0, NULL, '新発田いのちのパンチャーチ 教会員専用ライセンス', 1, '2026-01-01T00:00:00.000Z'),
  ('NIWA-FOUNDER', 'personal', NULL, 50, 0, NULL, '初期サポーター・個人買い切り用コード', 1, '2026-01-01T00:00:00.000Z');
