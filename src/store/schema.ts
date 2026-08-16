export const SCHEMA_VERSION = 3;

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waves (
  wave_id TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deadline_ms INTEGER,
  stop_at INTEGER,
  limits_json TEXT NOT NULL,
  counters_json TEXT NOT NULL,
  flow_id TEXT,
  owner TEXT NOT NULL,
  next_action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  quota_mode TEXT NOT NULL DEFAULT 'tokens'
);

CREATE TABLE IF NOT EXISTS ticket_runs (
  wave_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  ord INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  owner TEXT NOT NULL,
  next_action TEXT NOT NULL,
  plan_class TEXT,
  plan_artifact TEXT,
  impl_worktree TEXT,
  impl_branch TEXT,
  verify_proof TEXT,
  verify_command TEXT,
  provider TEXT,
  model TEXT,
  result TEXT,
  PRIMARY KEY (wave_id, ticket_id),
  FOREIGN KEY (wave_id) REFERENCES waves(wave_id)
);

CREATE TABLE IF NOT EXISTS stage_runs (
  stage_run_id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  model TEXT,
  provider TEXT,
  task_id TEXT,
  run_id TEXT,
  session_id TEXT,
  receipt_json TEXT,
  output_ref TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (wave_id, ticket_id, stage, attempt),
  FOREIGN KEY (wave_id) REFERENCES waves(wave_id)
);

CREATE TABLE IF NOT EXISTS budget_entries (
  budget_id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL,
  stage_run_id TEXT,
  tokens_reserved INTEGER NOT NULL,
  cost_reserved_micros INTEGER NOT NULL,
  tokens_actual INTEGER,
  cost_actual_micros INTEGER,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (wave_id) REFERENCES waves(wave_id)
);

CREATE TABLE IF NOT EXISTS launch_outbox (
  outbox_id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  fencing_generation INTEGER NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  receipt_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (wave_id) REFERENCES waves(wave_id)
);

CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  holder TEXT NOT NULL,
  wave_id TEXT,
  ticket_id TEXT,
  task_id TEXT,
  process_identity TEXT NOT NULL,
  pid INTEGER,
  pid_start_time TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revision_applied INTEGER
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL,
  ticket_id TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_runs_wave ON ticket_runs(wave_id, ord);
CREATE INDEX IF NOT EXISTS idx_outbox_wave_state ON launch_outbox(wave_id, state);
CREATE INDEX IF NOT EXISTS idx_budget_wave_state ON budget_entries(wave_id, state);
CREATE INDEX IF NOT EXISTS idx_events_wave ON events(wave_id, created_at);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE ticket_runs ADD COLUMN writer_scope TEXT;
ALTER TABLE ticket_runs ADD COLUMN human_hold INTEGER;
ALTER TABLE ticket_runs ADD COLUMN human_hold_reason TEXT;
ALTER TABLE ticket_runs ADD COLUMN product TEXT;
ALTER TABLE ticket_runs ADD COLUMN game TEXT;
`,
  },
  {
    version: 3,
    sql: `
ALTER TABLE ticket_runs ADD COLUMN impl_sha TEXT;
`,
  },
];
