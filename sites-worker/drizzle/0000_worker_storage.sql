CREATE TABLE IF NOT EXISTS worker_sessions (
  session_id_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS worker_sessions_expiry ON worker_sessions (expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS oauth_handoffs (
  handoff_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_handoffs_expiry ON oauth_handoffs (expires_at);

CREATE TABLE IF NOT EXISTS statistics_events (
  event_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS statistics_events_created ON statistics_events (created_at, event_id);

CREATE TABLE IF NOT EXISTS statistics_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS statistics_flush_locks (
  lock_name TEXT PRIMARY KEY,
  lock_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
