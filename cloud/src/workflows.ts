import { sha256Hex, type Role } from "./auth";
import { classifyById, collapseById, type Classified } from "./classify";
import {
  findActiveContentDuplicate,
  findOpenReview,
  getObligation,
  getRestoreBatch,
  getTransaction,
  insertAudit,
  insertObligation,
  insertReview,
  insertTransaction,
  listAllTransactions,
  listObligations,
  saveRestoreBatch,
  setRestoreStatus,
  updateObligation,
  updateTransaction,
  type Database,
} from "./db";
import { HttpError } from "./http";
import { parseLedgerDocument, type ParsedDocument, type RowSet } from "./legacy";
import {
  obligationSignature,
  toPublicObligation,
  toPublicTx,
  txContentKey,
  txSignature,
  type ObligationPayload,
  type TxPayload,
} from "./model";
import { parseWriteObligation, parseWriteTransaction } from "./validate";

export interface Principal {
  role: Role;
  actor: string;
}

const COMPLETENESS = {
  phoneCompleteness: "unknown",
  notionSyncClaim: "none",
  cutover: "not_performed",
  liveRowsDeleted: 0,
  liveRowsOverwritten: 0,
} as const;

export async function createTransaction(
  db: Database,
  principal: Principal,
  body: Record<string, unknown>,
  idempotencyKey: string,
  now: Date,
): Promise<{ status: number; body: unknown }> {
  const generatedId = `tx_${(await sha256Hex(`tx:${principal.actor}:${idempotencyKey}`)).slice(0, 24)}`;
  const parsed = parseWriteTransaction(body, null, generatedId);
  if (!parsed.ok) throw new HttpError(400, "validation_failed", { fields: parsed.fields });
  const tx = { ...parsed.value.tx, version: 1 };
  const at = now.toISOString();
  const current = await getTransaction(db, tx.id);
  if (current) {
    if (txSignature(current) === txSignature({ ...tx, version: current.version, updatedAt: current.updatedAt })) {
      return { status: 200, body: { ok: true, tx: toPublicTx(current), idempotent: true } };
    }
    const reviewId = await preserveConflict(db, principal, "transaction_conflict", current, tx, at);
    return conflictBody(409, "id_conflict", toPublicTx(current), toPublicTx(tx), reviewId);
  }
  if (!parsed.value.confirmDuplicate && !tx.voided) {
    const duplicateId = await findActiveContentDuplicate(db, txContentKey(tx), tx.id);
    if (duplicateId) {
      const duplicate = await getTransaction(db, duplicateId);
      const reviewId = await preserveConflict(db, principal, "content_duplicate", duplicate, tx, at);
      return conflictBody(409, "duplicate_suspected", duplicate ? toPublicTx(duplicate) : null, toPublicTx(tx), reviewId);
    }
  }
  await insertTransaction(db, tx, at);
  const saved = { ...tx, updatedAt: at };
  await insertAudit(db, { at, actor: principal.actor, action: "create", targetId: tx.id, version: 1, detail: { after: toPublicTx(saved) } });
  return { status: 201, body: { ok: true, tx: toPublicTx(saved) } };
}

export async function updateTransactionFlow(
  db: Database,
  principal: Principal,
  id: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ status: number; body: unknown }> {
  const current = await getTransaction(db, id);
  if (!current) throw new HttpError(404, "not_found");
  const parsed = parseWriteTransaction({ ...body, id }, current, id);
  if (!parsed.ok) throw new HttpError(400, "validation_failed", { fields: parsed.fields });
  const expected = parsed.value.expectedVersion;
  if (expected === null) throw new HttpError(400, "validation_failed", { fields: { expectedVersion: "invalid" } });
  const next = { ...parsed.value.tx, id, version: current.version };
  const at = now.toISOString();
  if (expected !== current.version) {
    const reviewId = await preserveConflict(db, principal, "transaction_conflict", current, next, at);
    return conflictBody(409, "version_conflict", toPublicTx(current), toPublicTx(next), reviewId);
  }
  if (txSignature(current) === txSignature(next)) {
    return { status: 200, body: { ok: true, tx: toPublicTx(current), unchanged: true } };
  }
  if (!parsed.value.confirmDuplicate && !next.voided) {
    const duplicateId = await findActiveContentDuplicate(db, txContentKey(next), id);
    if (duplicateId) {
      const duplicate = await getTransaction(db, duplicateId);
      const reviewId = await preserveConflict(db, principal, "content_duplicate", duplicate, next, at);
      return conflictBody(409, "duplicate_suspected", duplicate ? toPublicTx(duplicate) : null, toPublicTx(next), reviewId);
    }
  }
  const updated = await updateTransaction(db, next, expected, at);
  if (!updated) {
    const fresh = await getTransaction(db, id);
    const reviewId = await preserveConflict(db, principal, "transaction_conflict", fresh, next, at);
    return conflictBody(409, "version_conflict", fresh ? toPublicTx(fresh) : null, toPublicTx(next), reviewId);
  }
  const saved = { ...next, version: expected + 1, updatedAt: at };
  await insertAudit(db, {
    at,
    actor: principal.actor,
    action: "update",
    targetId: id,
    version: saved.version,
    detail: { before: toPublicTx(current), after: toPublicTx(saved) },
  });
  return { status: 200, body: { ok: true, tx: toPublicTx(saved) } };
}

export async function createObligation(
  db: Database,
  principal: Principal,
  body: Record<string, unknown>,
  idempotencyKey: string,
  now: Date,
): Promise<{ status: number; body: unknown }> {
  const generatedId = `ob_${(await sha256Hex(`ob:${principal.actor}:${idempotencyKey}`)).slice(0, 24)}`;
  const parsed = parseWriteObligation(body, null, generatedId);
  if (!parsed.ok) throw new HttpError(400, "validation_failed", { fields: parsed.fields });
  const row = parsed.row;
  const current = await getObligation(db, row.id);
  const at = now.toISOString();
  if (current) {
    if (obligationSignature(current) === obligationSignature(row)) {
      return { status: 200, body: { ok: true, obligation: toPublicObligation(current), idempotent: true } };
    }
    const reviewId = await preserveConflict(db, principal, "obligation_conflict", current, row, at);
    return conflictBody(409, "id_conflict", toPublicObligation(current), toPublicObligation(row), reviewId);
  }
  const saved = { ...row, createdAt: row.createdAt ?? at, version: 1 };
  await insertObligation(db, saved, at);
  await insertAudit(db, { at, actor: principal.actor, action: "create_obligation", targetId: row.id, version: 1, detail: { after: toPublicObligation({ ...saved, updatedAt: at }) } });
  return { status: 201, body: { ok: true, obligation: toPublicObligation({ ...saved, updatedAt: at }) } };
}

export async function updateObligationFlow(
  db: Database,
  principal: Principal,
  id: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ status: number; body: unknown }> {
  const current = await getObligation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  const parsed = parseWriteObligation({ ...body, id }, current, id);
  if (!parsed.ok) throw new HttpError(400, "validation_failed", { fields: parsed.fields });
  const expected = parsed.expectedVersion;
  if (expected === null || expected !== current.version) {
    const reviewId = await preserveConflict(db, principal, "obligation_conflict", current, parsed.row, now.toISOString());
    return conflictBody(409, "version_conflict", toPublicObligation(current), toPublicObligation(parsed.row), reviewId);
  }
  if (obligationSignature(current) === obligationSignature(parsed.row)) {
    return { status: 200, body: { ok: true, obligation: toPublicObligation(current), unchanged: true } };
  }
  const at = now.toISOString();
  const next = { ...parsed.row, id, version: current.version };
  const updated = await updateObligation(db, next, expected, at);
  if (!updated) {
    const fresh = await getObligation(db, id);
    const reviewId = await preserveConflict(db, principal, "obligation_conflict", fresh, next, at);
    return conflictBody(409, "version_conflict", fresh ? toPublicObligation(fresh) : null, toPublicObligation(next), reviewId);
  }
  const saved = { ...next, version: expected + 1, updatedAt: at };
  await insertAudit(db, {
    at,
    actor: principal.actor,
    action: "update_obligation",
    targetId: id,
    version: saved.version,
    detail: { before: toPublicObligation(current), after: toPublicObligation(saved) },
  });
  return { status: 200, body: { ok: true, obligation: toPublicObligation(saved) } };
}

export async function previewImport(db: Database, body: unknown) {
  const report = await buildReport(db, body);
  return {
    status: report.blocked ? 200 : 200,
    body: {
      ok: true,
      wrote: false,
      applyAllowed: !report.blocked,
      ...report.publicReport,
      ...COMPLETENESS,
    },
  };
}

export async function applyImport(db: Database, principal: Principal, body: unknown, now: Date) {
  const report = await buildReport(db, body);
  if (report.blocked) {
    throw new HttpError(400, "migration_invalid", {
      applyAllowed: false,
      invalid: report.publicReport.invalid,
      fileConflicts: report.publicReport.fileConflicts,
      ...COMPLETENESS,
    });
  }
  const at = now.toISOString();
  const txResult = await applyTransactions(db, principal, report.transactions, at);
  const obResult = await applyObligations(db, principal, report.obligations, at);
  return {
    status: 200,
    body: {
      ok: true,
      wrote: true,
      transactions: txResult,
      obligations: obResult,
      totals: report.publicReport.totals,
      warnings: report.publicReport.warnings,
      ...COMPLETENESS,
      note: "同一編號且內容相同會略過。內容不同會留在審閱區，雲端原筆不覆蓋、不刪除。檔案裡沒有的雲端筆也不刪除。",
    },
  };
}

export async function stageRestore(db: Database, principal: Principal, body: unknown, now: Date, id: string) {
  const existing = await getRestoreBatch(db, id);
  if (existing) {
    const same = JSON.stringify(existing.payload) === JSON.stringify(body);
    if (!same) throw new HttpError(409, "idempotency_conflict");
    return { status: 200, body: { ok: true, wrote: false, staged: true, idempotent: true, batchId: id, report: existing.summary } };
  }
  const beforeTx = (await listAllTransactions(db)).length;
  const beforeOb = (await listObligations(db)).length;
  const preview = await previewImport(db, body);
  const at = now.toISOString();
  await saveRestoreBatch(db, { id, at, actor: principal.actor, status: "staged", summary: preview.body, payload: body });
  const afterTx = (await listAllTransactions(db)).length;
  const afterOb = (await listObligations(db)).length;
  return {
    status: 200,
    body: {
      ok: true,
      wrote: false,
      staged: true,
      batchId: id,
      liveTransactionsUnchanged: beforeTx === afterTx && beforeOb === afterOb,
      report: preview.body,
    },
  };
}

export async function commitRestore(db: Database, principal: Principal, id: string, now: Date) {
  const batch = await getRestoreBatch(db, id);
  if (!batch) throw new HttpError(404, "not_found");
  if (batch.status === "committed") {
    return { status: 200, body: { ok: true, idempotent: true, batchId: id, report: batch.summary } };
  }
  if (batch.status !== "staged") throw new HttpError(409, "restore_not_staged");
  const applied = await applyImport(db, principal, batch.payload, now);
  await setRestoreStatus(db, id, "committed", applied.body);
  return { status: 200, body: { ok: true, batchId: id, report: applied.body } };
}

export async function discardRestore(db: Database, id: string) {
  const batch = await getRestoreBatch(db, id);
  if (!batch) throw new HttpError(404, "not_found");
  if (batch.status === "committed") throw new HttpError(409, "restore_already_committed");
  await setRestoreStatus(db, id, "discarded", { discarded: true, previous: batch.summary });
  return { status: 200, body: { ok: true, batchId: id, discarded: true, liveRowsDeleted: 0 } };
}

async function buildReport(db: Database, body: unknown) {
  const parsed = parseLedgerDocument(body);
  const existingTx = await listAllTransactions(db);
  const existingOb = await listObligations(db);
  const txPlan = planRows(parsed.transactions, existingTx, txSignature, txContentKey);
  const obPlan = planRows(parsed.obligations, existingOb, obligationSignature, obligationSignature);
  if (txPlan.classified) {
    const kept: TxPayload[] = [];
    for (const row of txPlan.insertable) {
      if (!row.voided && (await findActiveContentDuplicate(db, txContentKey(row), row.id))) {
        txPlan.contentDuplicates += 1;
        continue;
      }
      kept.push(row);
    }
    txPlan.insertable = kept;
  }
  const invalid = [
    ...(parsed.transactions?.invalid ?? []).map((row) => ({ kind: "transaction", ...row })),
    ...(parsed.obligations?.invalid ?? []).map((row) => ({ kind: "obligation", ...row })),
  ];
  const fileConflicts = [
    ...txPlan.fileConflicts.map((row) => ({ kind: "transaction", ...row })),
    ...obPlan.fileConflicts.map((row) => ({ kind: "obligation", ...row })),
  ];
  const blocked = invalid.length > 0 || fileConflicts.length > 0 || parsed.format === "invalid";
  const activeIncoming = (parsed.transactions?.rows ?? []).filter((row) => !row.voided);
  return {
    blocked,
    transactions: blocked ? null : txPlan,
    obligations: blocked || parsed.obligations === null ? null : obPlan,
    publicReport: {
      format: parsed.format,
      transactionsPresent: parsed.transactions !== null,
      obligationsPresent: parsed.obligations !== null,
      counts: {
        incomingTransactions: parsed.transactions?.rows.length ?? 0,
        invalid: invalid.length,
        identical: txPlan.classified?.identical.length ?? 0,
        conflicts: txPlan.classified?.conflicts.length ?? 0,
        onlyInCandidate: txPlan.insertable.length,
        onlyInCanonical: txPlan.classified?.onlyExisting.length ?? 0,
        contentDuplicates: txPlan.contentDuplicates,
        incomingObligations: parsed.obligations?.rows.length ?? 0,
        obligationConflicts: obPlan.classified?.conflicts.length ?? 0,
        obligationsOnlyInCanonical: parsed.obligations ? (obPlan.classified?.onlyExisting.length ?? 0) : null,
      },
      totals: totals(activeIncoming),
      conflicts: (txPlan.classified?.conflicts ?? []).map((row) => ({
        id: row.id,
        existing: toPublicTx(row.existing),
        incoming: toPublicTx(row.incoming),
      })),
      onlyInCanonicalIds: (txPlan.classified?.onlyExisting ?? []).map((row) => row.id),
      onlyInCandidateIds: txPlan.insertable.map((row) => row.id),
      invalid,
      fileConflicts,
      warnings: [...parsed.warnings, ...(parsed.transactions?.warnings ?? []), ...(parsed.obligations?.warnings ?? [])],
      byEntity: totals(activeIncoming).byEntity,
    },
  };
}

interface Plan<T extends { id: string }> {
  fileConflicts: Array<{ id: string; rows: T[] }>;
  classified: Classified<T> | null;
  contentDuplicates: number;
  insertable: T[];
}

function planRows<T extends { id: string }>(
  set: RowSet<T> | null,
  existing: T[],
  signature: (row: T) => string,
  content: (row: T) => string,
): Plan<T> {
  if (!set) return { fileConflicts: [], classified: null, contentDuplicates: 0, insertable: [] };
  const collapsed = collapseById(set.rows, signature);
  if (collapsed.conflicts.length > 0) {
    return { fileConflicts: collapsed.conflicts, classified: null, contentDuplicates: 0, insertable: [] };
  }
  const classified = classifyById(existing, collapsed.rows, signature);
  const groups = new Map<string, T[]>();
  for (const row of classified.onlyIncoming) {
    const key = content(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  let contentDuplicates = 0;
  const insertable: T[] = [];
  for (const list of groups.values()) {
    if (list.length > 1) contentDuplicates += list.length;
    else insertable.push(list[0]);
  }
  return { fileConflicts: [], classified, contentDuplicates, insertable };
}

async function applyTransactions(
  db: Database,
  principal: Principal,
  plan: Plan<TxPayload> | null,
  at: string,
) {
  if (!plan?.classified) return { inserted: 0, identical: 0, conflicts: 0, onlyInCanonical: 0, reviewIds: [] as number[] };
  const reviewIds: number[] = [];
  for (const conflict of plan.classified.conflicts) {
    reviewIds.push(await preserveConflict(db, principal, "transaction_conflict", conflict.existing, conflict.incoming, at));
  }
  const groups = new Map<string, TxPayload[]>();
  for (const row of plan.classified.onlyIncoming) {
    const key = txContentKey(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  let inserted = 0;
  let parked = 0;
  for (const [key, list] of groups) {
    if (list.length > 1) {
      for (let index = 1; index < list.length; index += 1) {
        reviewIds.push(await preserveConflict(db, principal, "content_duplicate", list[0], list[index], at));
      }
      parked += list.length;
      continue;
    }
    const row = list[0];
    if (!row.voided) {
      const duplicateId = await findActiveContentDuplicate(db, key, row.id);
      if (duplicateId) {
        const duplicate = await getTransaction(db, duplicateId);
        reviewIds.push(await preserveConflict(db, principal, "content_duplicate", duplicate, row, at));
        parked += 1;
        continue;
      }
    }
    const saved = { ...row, version: 1 };
    await insertTransaction(db, saved, at);
    await insertAudit(db, { at, actor: principal.actor, action: "migrate_insert", targetId: row.id, version: 1, detail: { after: toPublicTx({ ...saved, updatedAt: at }) } });
    inserted += 1;
  }
  return {
    inserted,
    identical: plan.classified.identical.length,
    conflicts: plan.classified.conflicts.length,
    contentDuplicatesParked: parked,
    onlyInCanonical: plan.classified.onlyExisting.length,
    reviewIds,
  };
}

async function applyObligations(db: Database, principal: Principal, plan: Plan<ObligationPayload> | null, at: string) {
  if (!plan?.classified) return { present: plan !== null, inserted: 0, identical: 0, conflicts: 0, onlyInCanonical: null as number | null, reviewIds: [] as number[] };
  const reviewIds: number[] = [];
  for (const conflict of plan.classified.conflicts) {
    reviewIds.push(await preserveConflict(db, principal, "obligation_conflict", conflict.existing, conflict.incoming, at));
  }
  let inserted = 0;
  for (const row of plan.classified.onlyIncoming) {
    const saved = { ...row, version: 1, createdAt: row.createdAt ?? at };
    await insertObligation(db, saved, at);
    await insertAudit(db, {
      at,
      actor: principal.actor,
      action: "migrate_obligation",
      targetId: row.id,
      version: 1,
      detail: { after: toPublicObligation({ ...saved, updatedAt: at }) },
    });
    inserted += 1;
  }
  return {
    present: true,
    inserted,
    identical: plan.classified.identical.length,
    conflicts: plan.classified.conflicts.length,
    onlyInCanonical: plan.classified.onlyExisting.length,
    reviewIds,
  };
}

function totals(rows: TxPayload[]) {
  const byEntity: Record<string, { incomeCents: number; expenseCents: number; netCents: number }> = {};
  let incomeCents = 0;
  let expenseCents = 0;
  for (const row of rows) {
    const bucket = byEntity[row.entity] ?? { incomeCents: 0, expenseCents: 0, netCents: 0 };
    if (row.type === "income") {
      incomeCents += row.amountCents;
      bucket.incomeCents += row.amountCents;
    } else {
      expenseCents += row.amountCents;
      bucket.expenseCents += row.amountCents;
    }
    bucket.netCents = bucket.incomeCents - bucket.expenseCents;
    byEntity[row.entity] = bucket;
  }
  return { incomeCents, expenseCents, netCents: incomeCents - expenseCents, byEntity };
}

async function preserveConflict(
  db: Database,
  principal: Principal,
  kind: string,
  existing: unknown,
  incoming: unknown,
  at: string,
): Promise<number> {
  const incomingHash = await sha256Hex(JSON.stringify(incoming));
  const targetId = idOf(existing) ?? idOf(incoming) ?? "unknown";
  const open = await findOpenReview(db, kind, targetId, incomingHash);
  const reviewId = await insertReview(db, { kind, targetId, incomingHash, existing: existing ?? null, incoming, at });
  if (open === null) {
    await insertAudit(db, {
      at,
      actor: principal.actor,
      action: "conflict_preserved",
      targetId,
      version: null,
      detail: { kind, reviewId },
    });
  }
  return reviewId;
}

function conflictBody(status: number, error: string, existing: unknown, incoming: unknown, reviewId: number) {
  return {
    status,
    body: {
      ok: false,
      error,
      preserved: true,
      overwritten: false,
      details: { existing, incoming, reviewId },
    },
  };
}

function idOf(value: unknown): string | null {
  if (value && typeof value === "object" && "id" in value && typeof (value as { id: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

export type { ParsedDocument };
