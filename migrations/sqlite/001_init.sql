CREATE TABLE IF NOT EXISTS fcgbds_counters (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
);

CREATE TABLE IF NOT EXISTS fcgbds_seen (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
);

CREATE TABLE IF NOT EXISTS fcgbds_list_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  match_type TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fcgbds_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
