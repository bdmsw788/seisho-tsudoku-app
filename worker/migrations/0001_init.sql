-- みことばの庭 iPhone通知機能 初期スキーマ
-- 通知枠を固定カラム・固定配列にせず、1枠1レコードで自由に追加・削除できる設計

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_slots (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  time_hhmm TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_slots_device_time
  ON notification_slots(device_id, time_hhmm, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_slots_enabled_time
  ON notification_slots(enabled, time_hhmm);

CREATE TABLE IF NOT EXISTS notification_logs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  sent_date TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  sent_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES notification_slots(id) ON DELETE CASCADE,
  UNIQUE (slot_id, sent_date)
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_slot_date
  ON notification_logs(slot_id, sent_date);
