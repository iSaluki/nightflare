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

-- Auth: mirrors Nightscout's subject/role model, matching the REST contract
-- its real admin UI (admin_plugins/subjects.js, roles.js) expects at
-- /api/v2/authorization/*. Subjects don't store a token at all: it's
-- derived deterministically from `id` + the deployment's API_SECRET at read
-- time (see lib/auth.ts deriveAccessToken), so it's stable, never persisted,
-- and rotates automatically if the secret changes.
CREATE TABLE auth_roles (
  id TEXT,                        -- null for the built-in default roles (not user-deletable)
  name TEXT PRIMARY KEY,
  permissions TEXT NOT NULL,      -- JSON array of permission patterns
  notes TEXT
);

CREATE TABLE auth_subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_names TEXT NOT NULL,       -- JSON array of auth_roles.name
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Matches Nightscout's own built-in default role set exactly (storage.defaultRoles).
INSERT INTO auth_roles (id, name, permissions, notes) VALUES
  (NULL, 'admin', '["*"]', 'Full access to everything'),
  (NULL, 'denied', '[]', 'No access'),
  (NULL, 'status-only', '["api:status:read"]', 'Can only read server status'),
  (NULL, 'readable', '["*:*:read"]', 'Read-only access to all collections'),
  (NULL, 'careportal', '["api:treatments:create"]', 'Can log treatments via Care Portal'),
  (NULL, 'devicestatus-upload', '["api:devicestatus:create"]', 'Can upload device status'),
  (NULL, 'activity', '["api:activity:create"]', 'Can upload activity records');

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
