-- Native Sites storage. Text JSON stays in D1; immutable assets and large or
-- non-JSON bodies live in R2 behind a D1 pointer.
CREATE TABLE IF NOT EXISTS native_documents (
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  namespace TEXT NOT NULL CHECK (namespace IN ('data', 'content', 'media')),
  path TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content TEXT,
  blob_key TEXT,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (site, namespace, path),
  CHECK (
    (is_deleted = 1 AND content IS NULL AND blob_key IS NULL)
    OR (is_deleted = 0 AND ((content IS NOT NULL AND blob_key IS NULL) OR (content IS NULL AND blob_key IS NOT NULL)))
  )
);
CREATE INDEX IF NOT EXISTS native_documents_site_ns_path ON native_documents (site, namespace, path);
CREATE INDEX IF NOT EXISTS native_documents_updated ON native_documents (site, updated_at DESC, namespace, path);

CREATE TABLE IF NOT EXISTS native_document_revisions (
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  namespace TEXT NOT NULL CHECK (namespace IN ('data', 'content', 'media')),
  path TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40),
  content TEXT,
  blob_key TEXT,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  summary TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site, namespace, path, version),
  UNIQUE (site, namespace, path, commit_sha),
  CHECK (
    (is_deleted = 1 AND content IS NULL AND blob_key IS NULL)
    OR (is_deleted = 0 AND ((content IS NOT NULL AND blob_key IS NULL) OR (content IS NULL AND blob_key IS NOT NULL)))
  )
);
CREATE INDEX IF NOT EXISTS native_document_revisions_history ON native_document_revisions (site, namespace, path, version DESC);

-- All files in a proposed change are staged here. Live document pointers move
-- together only when the reviewer approves the entire change.
CREATE TABLE IF NOT EXISTS native_changes (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  actor_login TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS native_changes_site_state_number ON native_changes (site, state, number DESC);

CREATE TABLE IF NOT EXISTS native_change_files (
  change_id TEXT NOT NULL REFERENCES native_changes(change_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  namespace TEXT NOT NULL CHECK (namespace IN ('data', 'content', 'media')),
  path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  content TEXT,
  blob_key TEXT,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (change_id, ordinal),
  UNIQUE (change_id, namespace, path)
);
CREATE INDEX IF NOT EXISTS native_change_files_site_path ON native_change_files (site, namespace, path);

-- One open proposal owns each target path. This prevents two create-profile
-- proposals from both being approved against the same previously absent path.
CREATE TABLE IF NOT EXISTS native_path_reservations (
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  namespace TEXT NOT NULL CHECK (namespace IN ('data', 'content', 'media')),
  path TEXT NOT NULL,
  change_id TEXT NOT NULL REFERENCES native_changes(change_id) ON DELETE CASCADE,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (site, namespace, path),
  UNIQUE (change_id, namespace, path)
);
CREATE INDEX IF NOT EXISTS native_path_reservations_change ON native_path_reservations (change_id);

CREATE TABLE IF NOT EXISTS native_storage_idempotency (
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('apply', 'change')),
  resource_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site, actor_key, idempotency_key)
);
CREATE INDEX IF NOT EXISTS native_storage_idempotency_created ON native_storage_idempotency (created_at);

-- CHECK(valid = 1) deliberately aborts a D1 batch if any expected version or
-- review state is stale. D1 batch rollback keeps all document pointers atomic.
CREATE TABLE IF NOT EXISTS native_version_checks (
  check_id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

CREATE TABLE IF NOT EXISTS native_audit_events (
  event_id TEXT PRIMARY KEY,
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  actor_login TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  namespace TEXT,
  path TEXT,
  version INTEGER,
  sha256 TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS native_audit_events_site_time ON native_audit_events (site, created_at DESC, event_id);
CREATE INDEX IF NOT EXISTS native_audit_events_path_time ON native_audit_events (site, namespace, path, created_at DESC);

-- Search index is denormalized from imported and approved person documents.
-- Prefix token indexes keep lookup bounded as the registry grows.
CREATE TABLE IF NOT EXISTS native_people_index (
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  kind TEXT NOT NULL,
  person_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  birth_year TEXT,
  death_year TEXT,
  photo_url TEXT NOT NULL DEFAULT '',
  normalized_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site, kind, person_id)
);
CREATE INDEX IF NOT EXISTS native_people_index_prefix ON native_people_index (site, normalized_name, kind, person_id);
CREATE INDEX IF NOT EXISTS native_people_index_kind ON native_people_index (site, kind, person_id);

CREATE VIRTUAL TABLE IF NOT EXISTS native_people_fts USING fts5(
  site UNINDEXED,
  kind UNINDEXED,
  person_id UNINDEXED,
  display_name,
  first_name,
  last_name,
  normalized_name,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS native_statistics_events (
  event_id TEXT PRIMARY KEY,
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  event_type TEXT NOT NULL,
  person_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  query TEXT NOT NULL DEFAULT '',
  result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS native_statistics_by_site_time ON native_statistics_events (site, created_at DESC, event_id);
CREATE INDEX IF NOT EXISTS native_statistics_by_type_time ON native_statistics_events (site, event_type, created_at DESC, event_id);
CREATE INDEX IF NOT EXISTS native_statistics_by_person_time ON native_statistics_events (site, kind, person_id, created_at DESC, event_id);
CREATE INDEX IF NOT EXISTS native_statistics_by_query_time ON native_statistics_events (site, query, created_at DESC);

CREATE TABLE IF NOT EXISTS native_statistics_rollups (
  site TEXT NOT NULL CHECK (site IN ('genepedia', 'gravepedia')),
  bucket_hour TEXT NOT NULL,
  event_type TEXT NOT NULL,
  person_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  query TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  last_result_count INTEGER NOT NULL DEFAULT 0 CHECK (last_result_count >= 0),
  PRIMARY KEY (site, bucket_hour, event_type, person_id, kind, query)
);
CREATE INDEX IF NOT EXISTS native_statistics_rollups_query ON native_statistics_rollups (site, bucket_hour, event_type, query);
CREATE INDEX IF NOT EXISTS native_statistics_rollups_person ON native_statistics_rollups (site, bucket_hour, event_type, kind, person_id);

CREATE TRIGGER IF NOT EXISTS native_statistics_rollup_after_insert
AFTER INSERT ON native_statistics_events
BEGIN
  INSERT INTO native_statistics_rollups (site, bucket_hour, event_type, person_id, kind, query, event_count, first_at, last_at, last_result_count)
  VALUES (NEW.site, substr(NEW.created_at, 1, 13), NEW.event_type, NEW.person_id, NEW.kind, NEW.query, 1, NEW.created_at, NEW.created_at, NEW.result_count)
  ON CONFLICT(site, bucket_hour, event_type, person_id, kind, query) DO UPDATE SET
    event_count = native_statistics_rollups.event_count + 1,
    first_at = MIN(native_statistics_rollups.first_at, excluded.first_at),
    last_at = MAX(native_statistics_rollups.last_at, excluded.last_at),
    last_result_count = CASE WHEN excluded.last_at >= native_statistics_rollups.last_at THEN excluded.last_result_count ELSE native_statistics_rollups.last_result_count END;
END;
