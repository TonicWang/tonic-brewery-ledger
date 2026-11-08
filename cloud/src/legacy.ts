import { categoryInCatalog, normalizeEntity } from "./catalog";
import { isIsoDate } from "./dates";
import { parseMinorUnits, twdToCents } from "./money";
import {
  obligationContentKey,
  txContentKey,
  type InvalidRow,
  type ObligationPayload,
  type TxPayload,
  type WarningRow,
} from "./model";

export interface RowSet<T> {
  rows: T[];
  invalid: InvalidRow[];
  warnings: WarningRow[];
}

export interface ParsedDocument {
  format: string;
  transactions: RowSet<TxPayload> | null;
  obligations: RowSet<ObligationPayload> | null;
  warnings: WarningRow[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/;

export function parseLedgerDocument(body: unknown): ParsedDocument {
  const warnings: WarningRow[] = [];
  if (Array.isArray(body)) {
    const kind = arrayKind(body);
    if (kind === "obligations") {
      return { format: "array", transactions: null, obligations: parseObligations(body), warnings };
    }
    return { format: "array", transactions: parseTransactions(body, false), obligations: null, warnings };
  }
  if (!isRecord(body)) {
    return {
      format: "invalid",
      transactions: { rows: [], invalid: [{ index: 0, id: null, fields: { document: "invalid" }, raw: {} }], warnings: [] },
      obligations: null,
      warnings,
    };
  }
  const format = typeof body.version === "string" ? body.version : "object";
  if ("count" in body && Array.isArray(body.transactions) && body.count !== body.transactions.length) {
    warnings.push({ index: -1, id: null, code: "count_mismatch", detail: `count=${String(body.count)} length=${body.transactions.length}` });
  }
  const txSource = firstArray(body, ["txs", "transactions"]);
  const obSource = firstArray(body, ["obligations", "fixedMonthly", "固定支出"]);
  if (!txSource && !obSource) {
    return {
      format,
      transactions: { rows: [], invalid: [{ index: 0, id: null, fields: { document: "missing_rows" }, raw: {} }], warnings: [] },
      obligations: null,
      warnings,
    };
  }
  return {
    format,
    transactions: txSource ? parseTransactions(txSource.rows, format === "tonic-blue-1") : null,
    obligations: obSource ? parseObligations(obSource.rows) : null,
    warnings,
  };
}

function parseTransactions(rows: unknown[], preferMinor: boolean): RowSet<TxPayload> {
  const parsed: TxPayload[] = [];
  const invalid: InvalidRow[] = [];
  const warnings: WarningRow[] = [];
  rows.forEach((value, index) => {
    if (!isRecord(value)) {
      invalid.push({ index, id: null, fields: { row: "invalid" }, raw: {} });
      return;
    }
    const result = parseTransactionRow(value, index, preferMinor);
    warnings.push(...result.warnings);
    if (result.invalid) invalid.push(result.invalid);
    else if (result.row) parsed.push(result.row);
  });
  return { rows: parsed, invalid, warnings };
}

function parseTransactionRow(
  raw: Record<string, unknown>,
  index: number,
  preferMinor: boolean,
): { row?: TxPayload; invalid?: InvalidRow; warnings: WarningRow[] } {
  const warnings: WarningRow[] = [];
  const fields: Record<string, string> = {};
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID_PATTERN.test(id)) fields.id = "invalid";
  const date = typeof raw.date === "string" ? raw.date : "";
  if (!isIsoDate(date)) fields.date = "invalid";
  const type = parseType(raw.type);
  if (!type) fields.type = "invalid";
  const entity = normalizeEntity(raw.entity);
  if (!entity) fields.entity = "unknown";
  const category = typeof raw.category === "string" ? raw.category.trim() : "";
  if (!category || category.length > 80) fields.category = "invalid";
  const amount = readTxAmount(raw, preferMinor);
  if (amount.error) fields.amount = amount.error;
  const invoice = readInvoice(raw.hasInvoice);
  if (invoice === "invalid") fields.hasInvoice = "invalid";
  const note = raw.note === undefined || raw.note === null ? "" : raw.note;
  if (typeof note !== "string" || note.length > 2000) fields.note = "invalid";
  const created = readCreatedAt(raw);
  if (created.error) fields.createdAt = created.error;
  const voided = readVoided(raw);
  if (voided === "invalid") fields.voided = "conflict";
  if (Object.keys(fields).length > 0) {
    return { invalid: { index, id: id || null, fields, raw: slim(raw) }, warnings };
  }
  if (type && category && !categoryInCatalog(type, category)) {
    warnings.push({ index, id, code: "category_preserved", detail: category });
  }
  const row: TxPayload = {
    id,
    date,
    type: type!,
    entity: entity!,
    category,
    amountCents: amount.cents!,
    hasInvoice: invoice === "invalid" ? null : invoice,
    note: note as string,
    createdAt: created.createdAt,
    createdAtMs: created.createdAtMs,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    version: positiveInt(raw.version) ?? 1,
    voided: voided === true,
  };
  row.updatedAt = row.updatedAt && !Number.isNaN(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toISOString() : null;
  void txContentKey(row);
  return { row, warnings };
}

function readTxAmount(raw: Record<string, unknown>, preferMinor: boolean): { cents?: number; error?: string } {
  const hasMinor = "amountCents" in raw || "amount_cents" in raw;
  const minorSource = "amountCents" in raw ? raw.amountCents : raw.amount_cents;
  if (hasMinor || preferMinor) {
    const minor = parseMinorUnits(minorSource);
    if (!hasMinor) {
      const major = twdToCents(raw.amount);
      if (major === "blank" || major === "invalid") return { error: "invalid" };
      return { cents: major };
    }
    if (minor === "blank" || minor === "invalid") return { error: "invalid" };
    if ("amount" in raw && raw.amount !== undefined && raw.amount !== null && raw.amount !== "") {
      const major = twdToCents(raw.amount);
      if (major === "invalid" || major === "blank" || major !== minor) return { error: "mismatch" };
    }
    return { cents: minor };
  }
  const major = twdToCents(raw.amount);
  if (major === "blank" || major === "invalid") return { error: "invalid" };
  return { cents: major };
}

export function parseObligations(rows: unknown[]): RowSet<ObligationPayload> {
  const parsed: ObligationPayload[] = [];
  const invalid: InvalidRow[] = [];
  const warnings: WarningRow[] = [];
  rows.forEach((value, index) => {
    if (!isRecord(value)) {
      invalid.push({ index, id: null, fields: { row: "invalid" }, raw: {} });
      return;
    }
    const result = parseObligationRecord(value, { partial: false, existing: null, generateId: true });
    if (!result.ok) {
      invalid.push({ index, id: stringOrNull(value.id), fields: result.fields, raw: slim(value) });
      return;
    }
    if (result.generatedId) warnings.push({ index, id: result.row.id, code: "generated_obligation_id" });
    parsed.push(result.row);
  });
  return { rows: parsed, invalid, warnings };
}

export function parseObligationRecord(
  raw: Record<string, unknown>,
  options: { partial: boolean; existing: ObligationPayload | null; generateId: boolean },
): { ok: true; row: ObligationPayload; generatedId: boolean } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const present = (keys: string[]) => keys.some((key) => key in raw);
  const read = (keys: string[]) => {
    for (const key of keys) if (key in raw) return raw[key];
    return undefined;
  };
  const base = options.existing;
  let generatedId = false;
  let id = base?.id ?? "";
  if (present(["id", "外部ID"])) {
    const value = read(["id", "外部ID"]);
    id = typeof value === "string" ? value.trim() : "";
  }
  if (!id && options.generateId) {
    id = obligationIdFrom(raw);
    generatedId = true;
  }
  if (!ID_PATTERN.test(id)) fields.id = "invalid";

  let entity = base?.entity ?? "";
  if (!options.partial || present(["entity", "業務體"])) {
    const normalized = normalizeEntity(read(["entity", "業務體"]));
    if (!normalized) fields.entity = "unknown";
    else entity = normalized;
  }
  let item = base?.item ?? "";
  if (!options.partial || present(["item", "項目"])) {
    const value = read(["item", "項目"]);
    item = typeof value === "string" ? value.trim() : "";
    if (!item || item.length > 80) fields.item = "invalid";
  }
  let cycle = base?.cycle ?? null;
  if (!options.partial || present(["cycle", "週期"])) {
    const parsed = readOptionalText(read(["cycle", "週期"]), 40);
    if (parsed === "invalid") fields.cycle = "invalid";
    else cycle = parsed;
  }
  let dueDate = base?.dueDate ?? null;
  if (!options.partial || present(["dueDate", "到期日"])) {
    const parsed = readDueDate(read(["dueDate", "到期日"]));
    if (parsed === "invalid") fields.dueDate = "invalid";
    else dueDate = parsed;
  }
  let note = base?.note ?? "";
  if (!options.partial || present(["note", "備註"])) {
    const value = read(["note", "備註"]);
    if (value === undefined || value === null) note = "";
    else if (typeof value !== "string" || value.length > 2000) fields.note = "invalid";
    else note = value;
  }
  let enabled = base?.enabled ?? null;
  if (!options.partial || present(["enabled", "啟用"])) {
    const parsed = readEnabled(read(["enabled", "啟用"]));
    if (parsed === "invalid") fields.enabled = "invalid";
    else enabled = parsed;
  }
  const billed = readOptionalMoney(raw, ["billedCents"], ["billed", "本次帳單"], options.partial, base?.billedCents ?? null);
  const paid = readOptionalMoney(raw, ["paidCents"], ["paid", "本次實付"], options.partial, base?.paidCents ?? null);
  const future = readOptionalMoney(
    raw,
    ["futureMonthlyCents"],
    ["futureMonthly", "未來月額"],
    options.partial,
    base?.futureMonthlyCents ?? null,
  );
  if (billed.error) fields.billed = billed.error;
  if (paid.error) fields.paid = paid.error;
  if (future.error) fields.futureMonthly = future.error;
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  const row: ObligationPayload = {
    id,
    entity,
    item,
    cycle,
    billedCents: billed.cents,
    paidCents: paid.cents,
    dueDate,
    futureMonthlyCents: future.cents,
    note,
    enabled,
    version: base?.version ?? (positiveInt(raw.version) ?? 1),
    createdAt: base?.createdAt ?? null,
    updatedAt: base?.updatedAt ?? null,
  };
  void obligationContentKey(row);
  return { ok: true, row, generatedId };
}

function readOptionalMoney(
  raw: Record<string, unknown>,
  minorKeys: string[],
  majorKeys: string[],
  partial: boolean,
  current: number | null,
): { cents: number | null; error?: string } {
  const hasMinor = minorKeys.some((key) => key in raw);
  const hasMajor = majorKeys.some((key) => key in raw);
  if (partial && !hasMinor && !hasMajor) return { cents: current };
  if (!hasMinor && !hasMajor) return { cents: null };
  let minor: number | "blank" | "invalid" | null = null;
  if (hasMinor) {
    minor = parseMinorUnits(firstPresent(raw, minorKeys));
    if (minor === "invalid") return { cents: null, error: "invalid" };
  }
  if (hasMajor) {
    const major = twdToCents(firstPresent(raw, majorKeys));
    if (major === "invalid") return { cents: null, error: "invalid" };
    if (minor !== null && minor !== "blank" && major !== "blank" && major !== minor) return { cents: null, error: "mismatch" };
    if (minor === null || minor === "blank") return { cents: major === "blank" ? null : major };
  }
  return { cents: minor === "blank" || minor === null ? null : minor };
}

function readDueDate(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "未知" || trimmed === "-" || trimmed === "—") return null;
  return isIsoDate(trimmed) ? trimmed : "invalid";
}

function readOptionalText(value: unknown, max: number): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "未知") return null;
  if (trimmed.length > max) return "invalid";
  return trimmed;
}

function readEnabled(value: unknown): boolean | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === 1 || value === "1" || value === "true" || value === "是" || value === "啟用") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "否" || value === "停用") return false;
  if (typeof value === "string" && (value.trim() === "" || value.trim() === "未知")) return null;
  return "invalid";
}

function readInvoice(value: unknown): boolean | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === 1 || value === "1" || value === "true" || value === "是" || value === "有") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "否" || value === "無") return false;
  return "invalid";
}

function readVoided(raw: Record<string, unknown>): boolean | "invalid" {
  const hasVoided = "voided" in raw;
  const hasDeleted = "deleted" in raw;
  const voided = hasVoided ? readInvoice(raw.voided) : null;
  const deleted = hasDeleted ? readInvoice(raw.deleted) : null;
  if (voided === "invalid" || deleted === "invalid") return "invalid";
  if (hasVoided && hasDeleted && voided !== deleted) return "invalid";
  return voided === true || deleted === true;
}

function readCreatedAt(raw: Record<string, unknown>): { createdAt: string | null; createdAtMs: number | null; error?: string } {
  const hasAt = "createdAt" in raw && raw.createdAt !== undefined && raw.createdAt !== null && raw.createdAt !== "";
  const hasMs = "createdAtMs" in raw && raw.createdAtMs !== undefined && raw.createdAtMs !== null && raw.createdAtMs !== "";
  let fromAt: { createdAt: string; createdAtMs: number } | null = null;
  let fromMs: { createdAt: string; createdAtMs: number } | null = null;
  if (hasAt) {
    const value = raw.createdAt;
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = Math.trunc(value);
      fromAt = { createdAt: new Date(ms).toISOString(), createdAtMs: ms };
    } else if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      const ms = Date.parse(value);
      fromAt = { createdAt: new Date(ms).toISOString(), createdAtMs: ms };
    } else return { createdAt: null, createdAtMs: null, error: "invalid" };
  }
  if (hasMs) {
    const ms = typeof raw.createdAtMs === "number" ? raw.createdAtMs : Number(raw.createdAtMs);
    if (!Number.isFinite(ms)) return { createdAt: null, createdAtMs: null, error: "invalid" };
    const truncated = Math.trunc(ms);
    fromMs = { createdAt: new Date(truncated).toISOString(), createdAtMs: truncated };
  }
  if (fromAt && fromMs && Math.abs(fromAt.createdAtMs - fromMs.createdAtMs) > 1) {
    return { createdAt: null, createdAtMs: null, error: "mismatch" };
  }
  return fromMs ?? fromAt ?? { createdAt: null, createdAtMs: null };
}

function parseType(value: unknown): "income" | "expense" | null {
  if (value === "income" || value === "收入") return "income";
  if (value === "expense" || value === "支出") return "expense";
  return null;
}

function obligationIdFrom(raw: Record<string, unknown>): string {
  const entity = typeof raw.entity === "string" ? raw.entity : typeof raw["業務體"] === "string" ? raw["業務體"] : "";
  const item = typeof raw.item === "string" ? raw.item : typeof raw["項目"] === "string" ? raw["項目"] : "";
  const cycle = typeof raw.cycle === "string" ? raw.cycle : typeof raw["週期"] === "string" ? raw["週期"] : "";
  const note = typeof raw.note === "string" ? raw.note : typeof raw["備註"] === "string" ? raw["備註"] : "";
  let hash = 2166136261;
  const text = `${entity}|${item}|${cycle}|${note}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ob_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function firstArray(body: Record<string, unknown>, keys: string[]): { rows: unknown[] } | null {
  for (const key of keys) {
    if (Array.isArray(body[key])) return { rows: body[key] as unknown[] };
  }
  return null;
}

function firstPresent(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (key in raw) return raw[key];
  return undefined;
}

function arrayKind(rows: unknown[]): "transactions" | "obligations" {
  const first = rows.find(isRecord);
  if (!first) return "transactions";
  if ("項目" in first || ("item" in first && !("type" in first) && !("amount" in first))) return "obligations";
  return "transactions";
}

function slim(raw: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > 180) output[key] = `${value.slice(0, 180)}…`;
    else output[key] = value;
  }
  return output;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
