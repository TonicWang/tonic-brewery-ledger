import { categoryInCatalog, entityKind, entityLabel, type EntityKind } from "./catalog";
import { centsToTwd } from "./money";

export interface TxPayload {
  id: string;
  date: string;
  type: "income" | "expense";
  entity: string;
  category: string;
  amountCents: number;
  hasInvoice: boolean | null;
  note: string;
  createdAt: string | null;
  createdAtMs: number | null;
  updatedAt: string | null;
  version: number;
  voided: boolean;
}

export interface PublicTx extends TxPayload {
  entityLabel: string;
  entityKind: EntityKind;
  categoryInCatalog: boolean;
  amount: string;
  currency: "TWD";
}

export interface ObligationPayload {
  id: string;
  entity: string;
  item: string;
  cycle: string | null;
  billedCents: number | null;
  paidCents: number | null;
  dueDate: string | null;
  futureMonthlyCents: number | null;
  note: string;
  enabled: boolean | null;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PublicObligation extends ObligationPayload {
  entityLabel: string;
  entityKind: EntityKind;
  billed: string | null;
  paid: string | null;
  futureMonthly: string | null;
  currency: "TWD";
}

export interface InvalidRow {
  index: number;
  id: string | null;
  fields: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface WarningRow {
  index: number;
  id: string | null;
  code: string;
  detail?: string;
}

export function txSignature(tx: TxPayload): string {
  return JSON.stringify([
    tx.id,
    tx.date,
    tx.type,
    tx.entity,
    tx.category,
    tx.amountCents,
    tx.hasInvoice,
    tx.note,
    tx.createdAt,
    tx.createdAtMs,
    tx.voided,
  ]);
}

export function txContentKey(tx: Pick<TxPayload, "date" | "type" | "entity" | "category" | "amountCents" | "hasInvoice" | "note">): string {
  return JSON.stringify([tx.date, tx.type, tx.entity, tx.category, tx.amountCents, tx.hasInvoice, tx.note]);
}

export function obligationSignature(row: ObligationPayload): string {
  return JSON.stringify([
    row.id,
    row.entity,
    row.item,
    row.cycle,
    row.billedCents,
    row.paidCents,
    row.dueDate,
    row.futureMonthlyCents,
    row.note,
    row.enabled,
  ]);
}

export function obligationContentKey(row: ObligationPayload): string {
  return obligationSignature(row);
}

export function toPublicTx(tx: TxPayload): PublicTx {
  return {
    ...tx,
    entityLabel: entityLabel(tx.entity),
    entityKind: entityKind(tx.entity),
    categoryInCatalog: categoryInCatalog(tx.type, tx.category),
    amount: centsToTwd(tx.amountCents),
    currency: "TWD",
  };
}

export function toPublicObligation(row: ObligationPayload): PublicObligation {
  return {
    ...row,
    entityLabel: entityLabel(row.entity),
    entityKind: entityKind(row.entity),
    billed: row.billedCents === null ? null : centsToTwd(row.billedCents),
    paid: row.paidCents === null ? null : centsToTwd(row.paidCents),
    futureMonthly: row.futureMonthlyCents === null ? null : centsToTwd(row.futureMonthlyCents),
    currency: "TWD",
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}
