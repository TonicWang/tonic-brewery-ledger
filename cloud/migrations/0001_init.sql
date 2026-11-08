-- Tonic Blue canonical ledger.
-- Money is integer minor units: 1 amount_cents = 0.01 TWD.
-- 22.5 TWD is 2250. Do not add a REAL amount column.
-- NULL on obligation dates and amounts means unknown, not zero.

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  entity TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  has_invoice INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  created_at_ms INTEGER,
  updated_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  content_key TEXT NOT NULL
);

CREATE INDEX idx_transactions_date ON transactions (date, id);
CREATE INDEX idx_transactions_entity_date ON transactions (entity, date);
CREATE INDEX idx_transactions_content ON transactions (content_key);

CREATE TABLE obligations (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  item TEXT NOT NULL,
  cycle TEXT,
  billed_cents INTEGER,
  paid_cents INTEGER,
  due_date TEXT,
  future_monthly_cents INTEGER,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT,
  updated_at TEXT,
  content_key TEXT NOT NULL
);

CREATE INDEX idx_obligations_entity ON obligations (entity);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  version INTEGER,
  detail_json TEXT NOT NULL
);

CREATE INDEX idx_audit_target ON audit_log (target_id, id);

CREATE TABLE idempotency_keys (
  actor TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, idem_key)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('reader', 'owner')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE login_limits (
  bucket TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  locked_until TEXT
);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at TEXT NOT NULL
);

CREATE TABLE review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  incoming_hash TEXT NOT NULL,
  existing_json TEXT NOT NULL,
  incoming_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_review_open ON review_items (kind, target_id, incoming_hash);

CREATE TABLE restore_batches (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'discarded')),
  summary_json TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
