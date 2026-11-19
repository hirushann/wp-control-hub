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
-- hub (dashboard) logins; "admin" + ADMIN_PASSWORD secret is a built-in super admin outside this table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('super', 'manager')),
  pw TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
