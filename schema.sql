CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  allowed_admins TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
-- every result the plugin sends back: status, scan, backup, update, restore
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ok INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_site_type ON reports (site_id, type, created_at);
