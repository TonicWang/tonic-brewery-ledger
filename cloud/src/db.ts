import { obligationContentKey, toPublicObligation, toPublicTx, txContentKey, type ObligationPayload, type TxPayload } from "./model";

export type SqlValue = string | number | null;

export interface Statement {
  bind(...values: SqlValue[]): Statement;
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface Database {
  prepare(sql: string): Statement;
}

interface TxRow {
  id: string;
  date: string;
  type: "income" | "expense";
  entity: string;
  category: string;
  amount_cents: number;
  has_invoice: number | null;
  note: string;
  created_at: string | null;
  created_at_ms: number | null;
  updated_at: string | null;
  version: number;
  voided: number;
  content_key: string;
}

interface ObligationRow {
  id: string;
  entity: string;
  item: string;
  cycle: string | null;
  billed_cents: number | null;
  paid_cents: number | null;
  due_date: string | null;
  future_monthly_cents: number | null;
  note: string;
  enabled: number | null;
  version: number;
  created_at: string | null;
  updated_at: string | null;
  content_key: string;
}

export interface TxFilter {
  from?: string | null;
  to?: string | null;
  entity?: string | null;
  scope?: "all" | "business" | "personal";
  type?: "income" | "expense" | null;
  query?: string | null;
  includeVoided?: boolean;
  cursorDate?: string | null;
  cursorId?: string | null;
  limit: number;
}

const TX_COLUMNS =
  "id, date, type, entity, category, amount_cents, has_invoice, note, created_at, created_at_ms, updated_at, version, voided, content_key";

export async function countTransactions(db: Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM transactions").bind().first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countObligations(db: Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM obligations").bind().first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getTransaction(db: Database, id: string): Promise<TxPayload | null> {
  const row = await db.prepare(`SELECT ${TX_COLUMNS} FROM transactions WHERE id = ?`).bind(id).first<TxRow>();
  return row ? mapTx(row) : null;
}

export async function listTransactions(db: Database, filter: TxFilter): Promise<TxPayload[]> {
  const where: string[] = ["1 = 1"];
  const values: SqlValue[] = [];
  if (filter.from) {
    where.push("date >= ?");
    values.push(filter.from);
  }
  if (filter.to) {
    where.push("date <= ?");
    values.push(filter.to);
  }
  if (filter.entity) {
    where.push("entity = ?");
    values.push(filter.entity);
  } else if (filter.scope === "business") {
    where.push("entity IN ('yapi', 'taros', 'beerwang', 'superhour', 'kaipi')");
  } else if (filter.scope === "personal") {
    where.push("entity = 'personal'");
  }
  if (filter.type) {
    where.push("type = ?");
    values.push(filter.type);
  }
  if (!filter.includeVoided) where.push("voided = 0");
  if (filter.query) {
    const like = `%${filter.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    where.push("(id LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')");
    values.push(like, like, like);
  }
  if (filter.cursorDate && filter.cursorId) {
    where.push("(date < ? OR (date = ? AND id < ?))");
    values.push(filter.cursorDate, filter.cursorDate, filter.cursorId);
  }
  values.push(filter.limit);
  const sql = `SELECT ${TX_COLUMNS} FROM transactions WHERE ${where.join(" AND ")} ORDER BY date DESC, id DESC LIMIT ?`;
  const result = await db.prepare(sql).bind(...values).all<TxRow>();
  return (result.results ?? []).map(mapTx);
}

export async function listAllTransactions(db: Database): Promise<TxPayload[]> {
  const result = await db.prepare(`SELECT ${TX_COLUMNS} FROM transactions ORDER BY date, id`).bind().all<TxRow>();
  return (result.results ?? []).map(mapTx);
}

export async function findActiveContentDuplicate(db: Database, contentKey: string, exceptId: string | null): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM transactions WHERE content_key = ? AND voided = 0 AND id != ? LIMIT 1")
    .bind(contentKey, exceptId ?? "")
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function insertTransaction(db: Database, tx: TxPayload, updatedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO transactions (${TX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tx.id,
      tx.date,
      tx.type,
      tx.entity,
      tx.category,
      tx.amountCents,
      boolOrNull(tx.hasInvoice),
      tx.note,
      tx.createdAt,
      tx.createdAtMs,
      updatedAt,
      tx.version,
      tx.voided ? 1 : 0,
      txContentKey(tx),
    )
    .run();
}

export async function updateTransaction(db: Database, tx: TxPayload, expectedVersion: number, updatedAt: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions SET date = ?, type = ?, entity = ?, category = ?, amount_cents = ?, has_invoice = ?, note = ?,
        created_at = ?, created_at_ms = ?, updated_at = ?, version = version + 1, voided = ?, content_key = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(
      tx.date,
      tx.type,
      tx.entity,
      tx.category,
      tx.amountCents,
      boolOrNull(tx.hasInvoice),
      tx.note,
      tx.createdAt,
      tx.createdAtMs,
      updatedAt,
      tx.voided ? 1 : 0,
      txContentKey(tx),
      tx.id,
      expectedVersion,
    )
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function listObligations(db: Database): Promise<ObligationPayload[]> {
  const result = await db.prepare("SELECT * FROM obligations ORDER BY entity, item, id").bind().all<ObligationRow>();
  return (result.results ?? []).map(mapObligation);
}

export async function getObligation(db: Database, id: string): Promise<ObligationPayload | null> {
  const row = await db.prepare("SELECT * FROM obligations WHERE id = ?").bind(id).first<ObligationRow>();
  return row ? mapObligation(row) : null;
}

export async function insertObligation(db: Database, row: ObligationPayload, updatedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO obligations (
        id, entity, item, cycle, billed_cents, paid_cents, due_date, future_monthly_cents, note, enabled, version, created_at, updated_at, content_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.entity,
      row.item,
      row.cycle,
      row.billedCents,
      row.paidCents,
      row.dueDate,
      row.futureMonthlyCents,
      row.note,
      boolOrNull(row.enabled),
      row.version,
      row.createdAt,
      updatedAt,
      obligationContentKey(row),
    )
    .run();
}

export async function updateObligation(db: Database, row: ObligationPayload, expectedVersion: number, updatedAt: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE obligations SET entity = ?, item = ?, cycle = ?, billed_cents = ?, paid_cents = ?, due_date = ?,
        future_monthly_cents = ?, note = ?, enabled = ?, updated_at = ?, version = version + 1, content_key = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(
      row.entity,
      row.item,
      row.cycle,
      row.billedCents,
      row.paidCents,
      row.dueDate,
      row.futureMonthlyCents,
      row.note,
      boolOrNull(row.enabled),
      updatedAt,
      obligationContentKey(row),
      row.id,
      expectedVersion,
    )
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function insertAudit(
  db: Database,
  entry: { at: string; actor: string; action: string; targetId: string | null; version: number | null; detail: unknown },
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (at, actor, action, target_id, version, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(entry.at, entry.actor, entry.action, entry.targetId, entry.version, JSON.stringify(entry.detail))
    .run();
}

export async function listAudit(db: Database, limit: number): Promise<unknown[]> {
  const result = await db
    .prepare("SELECT id, at, actor, action, target_id, version, detail_json FROM audit_log ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<{ id: number; at: string; actor: string; action: string; target_id: string | null; version: number | null; detail_json: string }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    targetId: row.target_id,
    version: row.version,
    detail: parseJson(row.detail_json),
  }));
}

export async function getIdempotency(db: Database, actor: string, key: string): Promise<{ requestHash: string; status: number; body: unknown } | null> {
  const row = await db
    .prepare("SELECT request_hash, status, response_json FROM idempotency_keys WHERE actor = ? AND idem_key = ?")
    .bind(actor, key)
    .first<{ request_hash: string; status: number; response_json: string }>();
  if (!row) return null;
  return { requestHash: row.request_hash, status: row.status, body: parseJson(row.response_json) };
}

export async function saveIdempotency(
  db: Database,
  entry: { actor: string; key: string; requestHash: string; status: number; body: unknown; at: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO idempotency_keys (actor, idem_key, request_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(entry.actor, entry.key, entry.requestHash, entry.status, JSON.stringify(entry.body), entry.at)
    .run();
}

export async function findOpenReview(db: Database, kind: string, targetId: string, incomingHash: string): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT id FROM review_items WHERE kind = ? AND target_id = ? AND incoming_hash = ? AND resolved_at IS NULL LIMIT 1",
    )
    .bind(kind, targetId, incomingHash)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function insertReview(
  db: Database,
  entry: { kind: string; targetId: string; incomingHash: string; existing: unknown; incoming: unknown; at: string },
): Promise<number> {
  const existing = await findOpenReview(db, entry.kind, entry.targetId, entry.incomingHash);
  if (existing !== null) return existing;
  await db
    .prepare(
      "INSERT INTO review_items (kind, target_id, incoming_hash, existing_json, incoming_json, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(entry.kind, entry.targetId, entry.incomingHash, JSON.stringify(entry.existing), JSON.stringify(entry.incoming), entry.at)
    .run();
  const created = await findOpenReview(db, entry.kind, entry.targetId, entry.incomingHash);
  return created ?? 0;
}

export async function listReview(db: Database, limit: number): Promise<unknown[]> {
  const result = await db
    .prepare(
      "SELECT id, kind, target_id, existing_json, incoming_json, created_at, resolved_at FROM review_items ORDER BY id DESC LIMIT ?",
    )
    .bind(limit)
    .all<{ id: number; kind: string; target_id: string; existing_json: string; incoming_json: string; created_at: string; resolved_at: string | null }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    existing: parseJson(row.existing_json),
    incoming: parseJson(row.incoming_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }));
}

export async function createSession(db: Database, tokenHash: string, role: "reader" | "owner", createdAt: string, expiresAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (token_hash, role, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
    .bind(tokenHash, role, createdAt, expiresAt)
    .run();
}

export async function getSession(db: Database, tokenHash: string, nowIso: string): Promise<{ role: "reader" | "owner"; expiresAt: string } | null> {
  const row = await db
    .prepare("SELECT role, expires_at, revoked_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ role: "reader" | "owner"; expires_at: string; revoked_at: string | null }>();
  if (!row || row.revoked_at || row.expires_at <= nowIso) return null;
  return { role: row.role, expiresAt: row.expires_at };
}

export async function revokeSession(db: Database, tokenHash: string, at: string): Promise<void> {
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(at, tokenHash).run();
}

export async function loginState(db: Database, bucket: string, nowIso: string): Promise<{ locked: boolean }> {
  const row = await db
    .prepare("SELECT locked_until FROM login_limits WHERE bucket = ?")
    .bind(bucket)
    .first<{ locked_until: string | null }>();
  return { locked: !!row?.locked_until && row.locked_until > nowIso };
}

export async function recordLoginFailure(db: Database, bucket: string, now: Date, limit: number): Promise<void> {
  const nowIso = now.toISOString();
  const row = await db
    .prepare("SELECT failures, window_start FROM login_limits WHERE bucket = ?")
    .bind(bucket)
    .first<{ failures: number; window_start: string }>();
  const windowMs = 15 * 60 * 1000;
  const fresh = !row || Date.parse(row.window_start) + windowMs <= now.getTime();
  const failures = fresh ? 1 : row.failures + 1;
  const windowStart = fresh ? nowIso : row.window_start;
  const lockedUntil = failures >= limit ? new Date(now.getTime() + windowMs).toISOString() : null;
  await db
    .prepare(
      `INSERT INTO login_limits (bucket, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`,
    )
    .bind(bucket, failures, windowStart, lockedUntil)
    .run();
}

export async function clearLoginFailures(db: Database, bucket: string): Promise<void> {
  await db.prepare("DELETE FROM login_limits WHERE bucket = ?").bind(bucket).run();
}

export async function bumpRate(db: Database, bucket: string, now: Date): Promise<number> {
  const resetAt = new Date(now.getTime() + 60_000).toISOString();
  const nowIso = now.toISOString();
  const row = await db.prepare("SELECT hits, reset_at FROM rate_limits WHERE bucket = ?").bind(bucket).first<{ hits: number; reset_at: string }>();
  if (!row || row.reset_at <= nowIso) {
    await db
      .prepare(
        `INSERT INTO rate_limits (bucket, hits, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET hits = 1, reset_at = excluded.reset_at`,
      )
      .bind(bucket, resetAt)
      .run();
    return 1;
  }
  const hits = row.hits + 1;
  await db.prepare("UPDATE rate_limits SET hits = ? WHERE bucket = ?").bind(hits, bucket).run();
  return hits;
}

export async function saveRestoreBatch(
  db: Database,
  batch: { id: string; at: string; actor: string; status: "staged" | "committed" | "discarded"; summary: unknown; payload: unknown },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO restore_batches (id, created_at, actor, status, summary_json, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(batch.id, batch.at, batch.actor, batch.status, JSON.stringify(batch.summary), JSON.stringify(batch.payload))
    .run();
}

export async function getRestoreBatch(db: Database, id: string): Promise<{
  id: string;
  status: "staged" | "committed" | "discarded";
  actor: string;
  createdAt: string;
  summary: unknown;
  payload: unknown;
} | null> {
  const row = await db
    .prepare("SELECT id, status, actor, created_at, summary_json, payload_json FROM restore_batches WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: "staged" | "committed" | "discarded"; actor: string; created_at: string; summary_json: string; payload_json: string }>();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    actor: row.actor,
    createdAt: row.created_at,
    summary: parseJson(row.summary_json),
    payload: parseJson(row.payload_json),
  };
}

export async function setRestoreStatus(db: Database, id: string, status: "staged" | "committed" | "discarded", summary: unknown): Promise<void> {
  await db.prepare("UPDATE restore_batches SET status = ?, summary_json = ? WHERE id = ?").bind(status, JSON.stringify(summary), id).run();
}

function mapTx(row: TxRow): TxPayload {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    entity: row.entity,
    category: row.category,
    amountCents: row.amount_cents,
    hasInvoice: row.has_invoice === null ? null : row.has_invoice === 1,
    note: row.note,
    createdAt: row.created_at,
    createdAtMs: row.created_at_ms,
    updatedAt: row.updated_at,
    version: row.version,
    voided: row.voided === 1,
  };
}

function mapObligation(row: ObligationRow): ObligationPayload {
  return {
    id: row.id,
    entity: row.entity,
    item: row.item,
    cycle: row.cycle,
    billedCents: row.billed_cents,
    paidCents: row.paid_cents,
    dueDate: row.due_date,
    futureMonthlyCents: row.future_monthly_cents,
    note: row.note,
    enabled: row.enabled === null ? null : row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boolOrNull(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function publicTransactions(rows: TxPayload[]) {
  return rows.map(toPublicTx);
}

export function publicObligations(rows: ObligationPayload[]) {
  return rows.map(toPublicObligation);
}
