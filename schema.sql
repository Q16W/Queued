-- Queued — D1 schema. Run once after creating the database (see DEPLOY.md).

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  pass_hash   TEXT,
  pass_salt   TEXT,
  google_sub  TEXT UNIQUE,
  name        TEXT,
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS state (
  user_id     TEXT PRIMARY KEY,
  json        TEXT,
  updated_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_sub);
