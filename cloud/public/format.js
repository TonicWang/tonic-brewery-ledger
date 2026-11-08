export const ENTITIES = {
  yapi: { label: "雅啤精釀", kind: "business" },
  taros: { label: "塔羅斯Talos", kind: "business" },
  beerwang: { label: "啤酒王", kind: "business" },
  superhour: { label: "超時餐飲", kind: "business" },
  kaipi: { label: "開啤", kind: "business" },
  personal: { label: "日常生活支出", kind: "personal" },
};

export function formatTwd(cents) {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}.${fraction}`;
}

export function entityKind(entity) {
  return ENTITIES[entity]?.kind ?? "unclassified";
}

export function entityLabel(entity) {
  return ENTITIES[entity]?.label ?? entity;
}

export function summarize(transactions, obligations, range) {
  const rows = transactions.filter((tx) => !tx.voided && tx.date >= range.from && tx.date <= range.to);
  const business = bucket(rows.filter((tx) => entityKind(tx.entity) === "business"));
  const personal = bucket(rows.filter((tx) => entityKind(tx.entity) === "personal"));
  const all = bucket(rows);
  const active = obligations.filter((row) => row.enabled === true);
  let knownFuture = 0;
  let unknownFuture = 0;
  let unknownDue = 0;
  let unknownPaid = 0;
  for (const row of active) {
    if (row.dueDate == null) unknownDue += 1;
    if (row.paidCents == null) unknownPaid += 1;
    if (row.futureMonthlyCents == null) unknownFuture += 1;
    else knownFuture += row.futureMonthlyCents;
  }
  return {
    range,
    disclaimer: "淨額＝收入−支出，不是銀行餘額，也不是完整損益。固定支出不會自動變成交易。",
    cashNetIsProfit: false,
    business,
    personal,
    all,
    byEntity: Object.keys(ENTITIES).map((entity) => ({
      entity,
      entityLabel: entityLabel(entity),
      entityKind: entityKind(entity),
      ...bucket(rows.filter((tx) => tx.entity === entity)),
    })).filter((row) => row.count > 0),
    expenseByCategory: group(rows.filter((tx) => tx.type === "expense"), (tx) => tx.category),
    expenseByNote: group(rows.filter((tx) => tx.type === "expense"), (tx) => tx.note || "（沒有備註）").map((row) => ({
      note: row.key,
      cents: row.cents,
      count: row.count,
    })),
    trend: trend(transactions, range.to),
    obligations: {
      activeCount: active.length,
      unknownEnabled: obligations.filter((row) => row.enabled == null).length,
      unknownDue,
      unknownPaid,
      knownFutureMonthlyCents: knownFuture,
      unknownFutureCount: unknownFuture,
      complete: unknownFuture === 0,
      includedInCashNet: false,
    },
  };
}

function bucket(rows) {
  let incomeCents = 0;
  let expenseCents = 0;
  for (const row of rows) {
    if (row.type === "income") incomeCents += row.amountCents;
    else expenseCents += row.amountCents;
  }
  return { incomeCents, expenseCents, netCents: incomeCents - expenseCents, count: rows.length };
}

function group(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const current = map.get(key) ?? { cents: 0, count: 0 };
    current.cents += row.amountCents;
    current.count += 1;
    map.set(key, current);
  }
  return [...map.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.cents - a.cents);
}

function trend(transactions, to) {
  const [year, month] = to.slice(0, 7).split("-").map(Number);
  const months = [];
  for (let index = 5; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(year, month - 1 - index, 1));
    months.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months.map((key) => ({
    month: key,
    business: bucket(transactions.filter((tx) => !tx.voided && tx.date.startsWith(key) && entityKind(tx.entity) === "business")),
    personal: bucket(transactions.filter((tx) => !tx.voided && tx.date.startsWith(key) && entityKind(tx.entity) === "personal")),
  }));
}
