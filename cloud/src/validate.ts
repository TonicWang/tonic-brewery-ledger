import { categoryInCatalog } from "./catalog";
import { isIsoDate } from "./dates";
import { parseObligationRecord } from "./legacy";
import { parseMinorUnits, twdToCents } from "./money";
import { txContentKey, type ObligationPayload, type TxPayload } from "./model";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/;
const ENTITY_KEYS = new Set(["yapi", "taros", "beerwang", "superhour", "kaipi", "personal"]);

export interface WriteTxResult {
  tx: TxPayload;
  confirmDuplicate: boolean;
  expectedVersion: number | null;
}

export function parseWriteTransaction(
  body: Record<string, unknown>,
  existing: TxPayload | null,
  generatedId: string,
): { ok: true; value: WriteTxResult } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const partial = existing !== null;
  const tx: TxPayload = existing
    ? { ...existing }
    : {
        id: generatedId,
        date: "",
        type: "expense",
        entity: "",
        category: "",
        amountCents: 0,
        hasInvoice: false,
        note: "",
        createdAt: null,
        createdAtMs: null,
        updatedAt: null,
        version: 1,
        voided: false,
      };
  if ("id" in body) {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!ID_PATTERN.test(id)) fields.id = "invalid";
    else tx.id = id;
  } else if (!partial && !ID_PATTERN.test(tx.id)) {
    fields.id = "invalid";
  }
  if (!partial || "date" in body) {
    if (typeof body.date !== "string" || !isIsoDate(body.date)) fields.date = "invalid";
    else tx.date = body.date;
  }
  if (!partial || "type" in body) {
    if (body.type !== "income" && body.type !== "expense") fields.type = "invalid";
    else tx.type = body.type;
  }
  if (!partial || "entity" in body) {
    if (typeof body.entity !== "string" || !ENTITY_KEYS.has(body.entity)) fields.entity = "invalid";
    else tx.entity = body.entity;
  }
  if (!partial || "category" in body) {
    const category = typeof body.category === "string" ? body.category : "";
    if (!category || category.length > 80) fields.category = "invalid";
    else tx.category = category;
  }
  if (!partial || "amount" in body || "amountCents" in body) {
    const amount = readAmount(body, partial);
    if (amount.error) fields.amount = amount.error;
    else if (amount.cents === undefined) fields.amount = "invalid";
    else tx.amountCents = amount.cents;
  }
  if (!partial || "hasInvoice" in body) {
    if (typeof body.hasInvoice !== "boolean") fields.hasInvoice = "invalid";
    else tx.hasInvoice = body.hasInvoice;
  }
  if (!partial || "note" in body) {
    if (body.note === undefined || body.note === null) tx.note = "";
    else if (typeof body.note !== "string" || body.note.length > 2000) fields.note = "invalid";
    else tx.note = body.note;
  }
  if ("createdAt" in body || "createdAtMs" in body) {
    const created = readCreated(body);
    if (created.error) fields.createdAt = created.error;
    else {
      tx.createdAt = created.createdAt;
      tx.createdAtMs = created.createdAtMs;
    }
  }
  if ("voided" in body || "deleted" in body) {
    const voided = body.voided;
    const deleted = body.deleted;
    if ("voided" in body && typeof voided !== "boolean") fields.voided = "invalid";
    if ("deleted" in body && typeof deleted !== "boolean") fields.deleted = "invalid";
    if (typeof voided === "boolean" && typeof deleted === "boolean" && voided !== deleted) fields.voided = "conflict";
    if (!fields.voided && !fields.deleted) tx.voided = voided === true || deleted === true;
  }
  let expectedVersion: number | null = null;
  if (partial) {
    if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
      fields.expectedVersion = "invalid";
    } else expectedVersion = body.expectedVersion;
  }
  if (tx.type && tx.category && !fields.category && !categoryInCatalog(tx.type, tx.category)) fields.category = "not_in_catalog";
  if (!partial && !tx.date) fields.date = fields.date ?? "invalid";
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  void txContentKey(tx);
  return {
    ok: true,
    value: {
      tx,
      confirmDuplicate: body.confirmDuplicate === true,
      expectedVersion,
    },
  };
}

export function parseWriteObligation(
  body: Record<string, unknown>,
  existing: ObligationPayload | null,
  generatedId: string,
): { ok: true; row: ObligationPayload; expectedVersion: number | null } | { ok: false; fields: Record<string, string> } {
  const seeded = { ...body };
  if (!("id" in seeded) && !("外部ID" in seeded)) seeded.id = existing?.id ?? generatedId;
  const parsed = parseObligationRecord(seeded, { partial: existing !== null, existing, generateId: false });
  if (!parsed.ok) return parsed;
  let expectedVersion: number | null = null;
  if (existing) {
    if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
      return { ok: false, fields: { expectedVersion: "invalid" } };
    }
    expectedVersion = body.expectedVersion;
  }
  return { ok: true, row: { ...parsed.row, version: existing?.version ?? 1 }, expectedVersion };
}

function readAmount(body: Record<string, unknown>, partial: boolean): { cents?: number; error?: string } {
  const hasMinor = "amountCents" in body;
  const hasMajor = "amount" in body;
  if (partial && !hasMinor && !hasMajor) return {};
  if (hasMinor) {
    const minor = parseMinorUnits(body.amountCents);
    if (minor === "blank" || minor === "invalid") return { error: "invalid" };
    if (hasMajor) {
      const major = twdToCents(body.amount);
      if (major === "invalid" || major === "blank" || major !== minor) return { error: "mismatch" };
    }
    return { cents: minor };
  }
  const major = twdToCents(body.amount);
  if (major === "blank" || major === "invalid") return { error: "invalid" };
  return { cents: major };
}

function readCreated(body: Record<string, unknown>): { createdAt: string | null; createdAtMs: number | null; error?: string } {
  if (body.createdAt === null || body.createdAt === "") return { createdAt: null, createdAtMs: null };
  if (typeof body.createdAt === "number" && Number.isFinite(body.createdAt)) {
    const ms = Math.trunc(body.createdAt);
    return { createdAt: new Date(ms).toISOString(), createdAtMs: ms };
  }
  if (typeof body.createdAt === "string" && !Number.isNaN(Date.parse(body.createdAt))) {
    const ms = Date.parse(body.createdAt);
    if ("createdAtMs" in body && typeof body.createdAtMs === "number" && Math.abs(body.createdAtMs - ms) > 1) {
      return { createdAt: null, createdAtMs: null, error: "mismatch" };
    }
    return { createdAt: new Date(ms).toISOString(), createdAtMs: ms };
  }
  if (typeof body.createdAtMs === "number" && Number.isFinite(body.createdAtMs)) {
    const ms = Math.trunc(body.createdAtMs);
    return { createdAt: new Date(ms).toISOString(), createdAtMs: ms };
  }
  return { createdAt: null, createdAtMs: null, error: "invalid" };
}
