import { CASH_NET_DISCLAIMER, entityKind, entityLabel } from "./catalog";
import { previousRange, trendMonthKeys } from "./dates";
import { addCents } from "./money";
import type { ObligationPayload, TxPayload } from "./model";

export interface MoneyBucket {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  count: number;
}

export interface StatsQuery {
  from: string;
  to: string;
  scope: "all" | "business" | "personal";
  entity: string | null;
}

export function emptyBucket(): MoneyBucket {
  return { incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 };
}

export function computeStats(txs: TxPayload[], obligations: ObligationPayload[], query: StatsQuery) {
  const previous = previousRange(query.from, query.to);
  const months = trendMonthKeys(query.to, 6);
  const trendStart = `${months[0]}-01`;
  const scoped = txs.filter((tx) => !tx.voided && inQuery(tx.entity, query));
  const period = scoped.filter((tx) => tx.date >= query.from && tx.date <= query.to);
  const prior = scoped.filter((tx) => tx.date >= previous.from && tx.date <= previous.to);
  const business = bucket(period.filter((tx) => entityKind(tx.entity) === "business"));
  const personal = bucket(period.filter((tx) => entityKind(tx.entity) === "personal"));
  const unclassified = bucket(period.filter((tx) => entityKind(tx.entity) === "unclassified"));
  const all = bucket(period);
  const previousBusiness = bucket(prior.filter((tx) => entityKind(tx.entity) === "business"));
  const previousPersonal = bucket(prior.filter((tx) => entityKind(tx.entity) === "personal"));
  const previousAll = bucket(prior);
  return {
    range: { from: query.from, to: query.to },
    previousRange: previous,
    disclaimer: CASH_NET_DISCLAIMER,
    cashNetIsProfit: false,
    netLabel: "淨額（收入−支出）",
    business,
    personal,
    unclassified,
    all,
    byEntity: byEntity(period),
    expenseByEntity: groupExpenses(period, (tx) => tx.entity).map((row) => ({
      entity: row.key,
      entityLabel: entityLabel(row.key),
      cents: row.cents,
      count: row.count,
    })),
    expenseByCategory: groupExpenses(period, (tx) => tx.category).map((row) => ({
      category: row.key,
      cents: row.cents,
      count: row.count,
    })),
    expenseByNote: expenseDetails(period),
    comparison: {
      previous: { business: previousBusiness, personal: previousPersonal, all: previousAll },
      delta: {
        businessNetCents: business.netCents - previousBusiness.netCents,
        personalNetCents: personal.netCents - previousPersonal.netCents,
        allNetCents: all.netCents - previousAll.netCents,
      },
    },
    trend: months.map((month) => {
      const monthTxs = scoped.filter((tx) => tx.date.startsWith(month) && tx.date >= trendStart && tx.date <= query.to);
      return {
        month,
        business: bucket(monthTxs.filter((tx) => entityKind(tx.entity) === "business")),
        personal: bucket(monthTxs.filter((tx) => entityKind(tx.entity) === "personal")),
      };
    }),
    obligations: summarizeObligations(
      obligations.filter((row) => inQuery(row.entity, query)),
    ),
  };
}

export function summarizeObligations(rows: ObligationPayload[]) {
  let knownFuture = 0;
  let unknownFuture = 0;
  let unknownDue = 0;
  let unknownPaid = 0;
  let unknownEnabled = 0;
  let activeCount = 0;
  let inactiveCount = 0;
  for (const row of rows) {
    if (row.enabled === null) {
      unknownEnabled += 1;
      continue;
    }
    if (row.enabled === false) {
      inactiveCount += 1;
      continue;
    }
    activeCount += 1;
    if (row.dueDate === null) unknownDue += 1;
    if (row.paidCents === null) unknownPaid += 1;
    if (row.futureMonthlyCents === null) unknownFuture += 1;
    else knownFuture = addCents([knownFuture, row.futureMonthlyCents]);
  }
  return {
    activeCount,
    inactiveCount,
    unknownEnabled,
    unknownDue,
    unknownPaid,
    knownFutureMonthlyCents: knownFuture,
    unknownFutureCount: unknownFuture,
    complete: unknownFuture === 0 && unknownEnabled === 0,
    includedInCashNet: false,
    note: "啟用中的未來月額是計畫，不是已入帳。空白的實付、到期日、月額維持未知，不會補 0，也不會寫成交易。",
  };
}

function bucket(txs: TxPayload[]): MoneyBucket {
  let incomeCents = 0;
  let expenseCents = 0;
  for (const tx of txs) {
    if (tx.type === "income") incomeCents = addCents([incomeCents, tx.amountCents]);
    else expenseCents = addCents([expenseCents, tx.amountCents]);
  }
  return { incomeCents, expenseCents, netCents: incomeCents - expenseCents, count: txs.length };
}

function byEntity(txs: TxPayload[]) {
  const keys = [...new Set(txs.map((tx) => tx.entity))];
  return keys.map((entity) => {
    const part = bucket(txs.filter((tx) => tx.entity === entity));
    return { entity, entityLabel: entityLabel(entity), entityKind: entityKind(entity), ...part };
  });
}

function groupExpenses(txs: TxPayload[], keyOf: (tx: TxPayload) => string) {
  const map = new Map<string, { cents: number; count: number }>();
  for (const tx of txs) {
    if (tx.type !== "expense") continue;
    const key = keyOf(tx);
    const current = map.get(key) ?? { cents: 0, count: 0 };
    current.cents = addCents([current.cents, tx.amountCents]);
    current.count += 1;
    map.set(key, current);
  }
  return [...map.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
}

function expenseDetails(txs: TxPayload[]) {
  const map = new Map<string, { entity: string; category: string; note: string; cents: number }>();
  for (const tx of txs) {
    if (tx.type !== "expense") continue;
    const note = tx.note || "（沒有備註）";
    const key = `${tx.entity}\t${tx.category}\t${note}`;
    const current = map.get(key) ?? { entity: tx.entity, category: tx.category, note, cents: 0 };
    current.cents = addCents([current.cents, tx.amountCents]);
    map.set(key, current);
  }
  return [...map.values()]
    .sort((a, b) => b.cents - a.cents || a.note.localeCompare(b.note))
    .slice(0, 30)
    .map((row) => ({ ...row, entityLabel: entityLabel(row.entity) }));
}

function inQuery(entity: string, query: StatsQuery): boolean {
  if (query.entity) return entity === query.entity;
  if (query.scope === "business") return entityKind(entity) === "business";
  if (query.scope === "personal") return entity === "personal";
  return true;
}
