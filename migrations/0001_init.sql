-- Core Nightscout-equivalent collections. Each table keeps a handful of
-- indexed columns for fast range/sort queries plus a `data` column holding
-- the full JSON document exactly as stored, so uploader-specific fields
-- (any app can send arbitrary extra keys) are never dropped.

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,             -- 'sgv' | 'mbg' | 'cal'
  date INTEGER NOT NULL,          -- epoch millis
  device TEXT,
  data TEXT NOT NULL,             -- full entry document (JSON)
  srv_created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_entries_date ON entries(date DESC);
CREATE INDEX idx_entries_type_date ON entries(type, date DESC);
CREATE UNIQUE INDEX idx_entries_dedupe ON entries(type, date, device);

CREATE TABLE treatments (
  id TEXT PRIMARY KEY,
  eventType TEXT,
  date INTEGER NOT NULL,          -- epoch millis, derived from created_at/timestamp
  device TEXT,
  data TEXT NOT NULL,
  srv_created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_treatments_date ON treatments(date DESC);
CREATE INDEX idx_treatments_eventtype_date ON treatments(eventType, date DESC);

CREATE TABLE devicestatus (
  id TEXT PRIMARY KEY,
  device TEXT,
  date INTEGER NOT NULL,
  data TEXT NOT NULL,
  srv_created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_devicestatus_date ON devicestatus(date DESC);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  date INTEGER NOT NULL,
  data TEXT NOT NULL,
  srv_created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_profiles_date ON profiles(date DESC);

CREATE TABLE food (
  id TEXT PRIMARY KEY,
  category TEXT,
  date INTEGER NOT NULL,
  data TEXT NOT NULL,
  srv_created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_food_date ON food(date DESC);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  date INTEGER NOT NULL,
  data TEXT NOT NULL,
  srv_created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_activity_date ON activity(date DESC);

-- Auth: mirrors Nightscout's subject/role model (roles hold permission
-- patterns like "*", "readable", "careportal", "admin"; subjects hold a
-- hashed access token and a list of role names).
CREATE TABLE auth_roles (
  name TEXT PRIMARY KEY,
  permissions TEXT NOT NULL,      -- JSON array of permission patterns
  notes TEXT
);

CREATE TABLE auth_subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_names TEXT NOT NULL,       -- JSON array of auth_roles.name
  access_token_hash TEXT,         -- sha256 hex of the issued token
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_auth_subjects_token ON auth_subjects(access_token_hash);

INSERT INTO auth_roles (name, permissions, notes) VALUES
  ('admin', '["*"]', 'Full access to everything'),
  ('readable', '["api:*:read","*:*:read"]', 'Read-only access to all collections'),
  ('careportal', '["api:treatments:create","api:treatments:read","api:treatments:update","*:*:read"]', 'Can log treatments via Care Portal');

-- Import jobs: track a bulk pull from another Nightscout instance.
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,           -- pending|running|completed|failed
  collections TEXT NOT NULL,      -- JSON array of collection names requested
  progress TEXT,                  -- JSON: {collection: {imported, total}}
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
