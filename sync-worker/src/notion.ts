/**
 * Pure Notion mapping plus a thin client.
 * Notion-Version: 2022-06-28. Callers inject fetch so tests never hit Notion.
 */

export const NOTION_VERSION = "2022-06-28";
export const NOTION_API = "https://api.notion.com/v1";
/** At most 3 Notion requests per second. */
export const MIN_GAP_MS = 334;
export const RICH_TEXT_LIMIT = 2000;

export const ENTITY_TO_LABEL: Record<string, string> = {
  yapi: "Tonic Brewery",
  taros: "塔羅斯",
  beerwang: "啤酒王",
  superhour: "超時餐飲",
  kaipi: "開啤",
  personal: "日常生活支出",
};

const LABEL_TO_ENTITY: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITY_TO_LABEL).map(([key, label]) => [label, key]),
);

export const CRM_STATUSES = [
  "pending_quote",
  "quoted",
  "negotiating",
  "signed",
  "dead",
] as const;

export type CrmStatus = (typeof CRM_STATUSES)[number];

export interface LedgerTx {
  id: string;
  date: string;
  type: "income" | "expense";
  entity: string;
  category: string;
  amount: number;
  hasInvoice: boolean;
  note: string;
  deleted: boolean;
  updatedAt?: string;
  createdAt?: number;
}

export interface CrmRecord {
  inquiryId: string;
  customerName?: string;
  phone?: string;
  lineId?: string;
  productType?: string;
  quantity?: number | string;
  quotePrice?: number | null;
  followUpDate?: string | null;
  lastContactDate?: string | null;
  owner?: string;
  notes?: string;
  status?: string;
  /** Kept only so a dead row can write 階段 back. Omitted from reads unless the client stored it. */
  stage?: string;
  history?: unknown[];
  updatedAt?: string;
  [key: string]: unknown;
}

export interface NotionPage {
  id: string;
  last_edited_time?: string;
  properties: Record<string, unknown>;
}

type RichText = { type: "text"; text: { content: string } };
type NotionProperties = Record<string, unknown>;

export class NotionRequestError extends Error {
  status: number;
  constructor(status: number) {
    super("notion request failed");
    this.name = "NotionRequestError";
    this.status = status;
  }
}

export function entityToLabel(entity: string): string | null {
  if (ENTITY_TO_LABEL[entity]) return ENTITY_TO_LABEL[entity];
  if (LABEL_TO_ENTITY[entity]) return entity;
  return null;
}

export function labelToEntity(label: string | null | undefined): string {
  if (!label) return "";
  return LABEL_TO_ENTITY[label] ?? label;
}

export function typeToLabel(type: string): "收入" | "支出" | null {
  if (type === "income") return "收入";
  if (type === "expense") return "支出";
  return null;
}

export function labelToType(label: string | null | undefined): "income" | "expense" | null {
  if (label === "收入") return "income";
  if (label === "支出") return "expense";
  return null;
}

export function richText(content: string): RichText[] {
  if (!content) return [];
  const chunks: RichText[] = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_LIMIT) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return chunks;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function ledgerTitle(tx: { note?: string; category?: string }): string {
  const note = tx.note?.trim() ?? "";
  const category = tx.category?.trim() ?? "";
  return truncate(note || category || "未命名", RICH_TEXT_LIMIT);
}

export function crmTitle(record: { customerName?: string; productType?: string; inquiryId?: string }): string {
  const title = [record.customerName, record.productType]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return truncate(title || record.inquiryId || "未命名", RICH_TEXT_LIMIT);
}

export function formatContact(phone?: string, lineId?: string): string {
  return [phone?.trim() ?? "", lineId?.trim() ?? ""].filter(Boolean).join(" / ");
}

export function parseContact(text: string): { phone: string; lineId: string } {
  const marker = " / ";
  const index = text.indexOf(marker);
  if (index === -1) return { phone: text, lineId: "" };
  return { phone: text.slice(0, index), lineId: text.slice(index + marker.length) };
}

export function formatCommitment(productType?: string, quantity?: number | string): string {
  const product = (productType ?? "").trim();
  if (quantity === undefined || quantity === null || quantity === "") return product;
  return product ? `${product} × ${quantity}` : `× ${quantity}`;
}

export function parseCommitment(text: string): { productType: string; quantity?: string } {
  const marker = " × ";
  const index = text.lastIndexOf(marker);
  if (index === -1) return { productType: text };
  return { productType: text.slice(0, index), quantity: text.slice(index + marker.length) };
}

export function crmStatusToNotion(
  status: string | undefined,
  stageHint?: string,
): { stage?: string; state?: string } {
  switch (status) {
    case "pending_quote":
      return { stage: "詢價", state: "待處理" };
    case "quoted":
      return { stage: "報價", state: "等客戶" };
    case "negotiating":
      return { stage: "報價", state: "待確認" };
    case "signed":
      return { stage: "成交", state: "已關閉" };
    case "dead":
      return stageHint ? { stage: stageHint, state: "已關閉" } : { state: "已關閉" };
    default:
      return {};
  }
}

export function notionToCrmStatus(stage: string | null, state: string | null): CrmStatus | undefined {
  if (state === "已關閉" && stage === "成交") return "signed";
  if (state === "已關閉") return "dead";
  if (stage === "詢價") return "pending_quote";
  if (stage === "報價" && state === "待確認") return "negotiating";
  if (stage === "報價") return "quoted";
  return undefined;
}

export function ledgerTxToProperties(tx: LedgerTx): NotionProperties {
  const entity = entityToLabel(tx.entity);
  const typeLabel = typeToLabel(tx.type);
  return {
    項目: { title: richText(ledgerTitle(tx)) },
    日期: tx.date ? { date: { start: tx.date } } : { date: null },
    類型: typeLabel ? { select: { name: typeLabel } } : { select: null },
    業務體: entity ? { select: { name: entity } } : { select: null },
    類別: tx.category ? { select: { name: tx.category } } : { select: null },
    金額: { number: Number.isFinite(tx.amount) ? tx.amount : null },
    有發票: { checkbox: !!tx.hasInvoice },
    備註: { rich_text: richText(tx.note ?? "") },
    來源: { select: { name: "帳本App" } },
    外部ID: { rich_text: richText(tx.id) },
    已刪除: { checkbox: !!tx.deleted },
  };
}

export function crmRecordToProperties(record: CrmRecord): NotionProperties {
  const mapped = crmStatusToNotion(record.status, typeof record.stage === "string" ? record.stage : undefined);
  const quote = record.quotePrice;
  const properties: NotionProperties = {
    項目: { title: richText(crmTitle(record)) },
    客戶: { rich_text: richText(record.customerName ?? "") },
    聯絡方式: { rich_text: richText(formatContact(record.phone, record.lineId)) },
    "承諾內容／下一步": { rich_text: richText(formatCommitment(record.productType, record.quantity)) },
    金額: { number: typeof quote === "number" && Number.isFinite(quote) ? quote : null },
    下次追蹤: { date: record.followUpDate ? { start: dateOnly(record.followUpDate) } : null },
    最後聯絡: { date: record.lastContactDate ? { start: dateOnly(record.lastContactDate) } : null },
    負責人: { rich_text: richText(record.owner ?? "") },
    備註: { rich_text: richText(record.notes ?? "") },
    品牌: { select: { name: "塔羅斯" } },
    來源: { multi_select: [{ name: "塔羅斯CRM" }] },
    外部ID: { rich_text: richText(record.inquiryId) },
  };
  if (mapped.state) properties["狀態"] = { select: { name: mapped.state } };
  if (mapped.stage) properties["階段"] = { select: { name: mapped.stage } };
  return properties;
}

function dateOnly(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function textItems(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as { plain_text?: string; text?: { content?: string } };
      return record.plain_text ?? record.text?.content ?? "";
    })
    .join("");
}

function prop(properties: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const value = properties[name];
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function plain(properties: Record<string, unknown>, name: string): string {
  const value = prop(properties, name);
  if (!value) return "";
  if (Array.isArray(value.title)) return textItems(value.title);
  if (Array.isArray(value.rich_text)) return textItems(value.rich_text);
  return "";
}

function selectName(properties: Record<string, unknown>, name: string): string | null {
  const value = prop(properties, name);
  const selected = value?.select;
  if (!selected || typeof selected !== "object") return null;
  const selectedName = (selected as { name?: unknown }).name;
  return typeof selectedName === "string" ? selectedName : null;
}

function checkbox(properties: Record<string, unknown>, name: string): boolean {
  return prop(properties, name)?.checkbox === true;
}

function numberValue(properties: Record<string, unknown>, name: string): number | null {
  const value = prop(properties, name)?.number;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateStart(properties: Record<string, unknown>, name: string): string | null {
  const date = prop(properties, name)?.date;
  if (!date || typeof date !== "object") return null;
  const start = (date as { start?: unknown }).start;
  return typeof start === "string" ? start : null;
}

export function notionPageToLedgerTx(page: NotionPage): LedgerTx | null {
  const id = plain(page.properties, "外部ID");
  if (!id) return null;
  const type = labelToType(selectName(page.properties, "類型"));
  if (!type) return null;
  const category = selectName(page.properties, "類別") ?? "";
  const title = plain(page.properties, "項目");
  const noteText = plain(page.properties, "備註");
  const note = noteText || (title && title !== category ? title : "");
  const tx: LedgerTx = {
    id,
    date: dateOnly(dateStart(page.properties, "日期") ?? ""),
    type,
    entity: labelToEntity(selectName(page.properties, "業務體")),
    category,
    amount: numberValue(page.properties, "金額") ?? 0,
    hasInvoice: checkbox(page.properties, "有發票"),
    note,
    deleted: checkbox(page.properties, "已刪除"),
  };
  if (page.last_edited_time) tx.updatedAt = page.last_edited_time;
  return tx;
}

export function notionPageToCrmRecord(page: NotionPage, body: unknown): CrmRecord | null {
  const externalId = plain(page.properties, "外部ID");
  const base =
    body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {};
  const inquiryId = externalId || (typeof base.inquiryId === "string" ? base.inquiryId : "");
  if (!inquiryId) return null;

  const record: CrmRecord = { ...(base as CrmRecord), inquiryId };
  record.customerName = plain(page.properties, "客戶");
  record.notes = plain(page.properties, "備註");
  record.owner = plain(page.properties, "負責人");
  record.quotePrice = numberValue(page.properties, "金額");
  const follow = dateStart(page.properties, "下次追蹤");
  const last = dateStart(page.properties, "最後聯絡");
  record.followUpDate = follow ? dateOnly(follow) : null;
  record.lastContactDate = last ? dateOnly(last) : null;

  const stage = selectName(page.properties, "階段");
  const state = selectName(page.properties, "狀態");
  const status = notionToCrmStatus(stage, state);
  if (status) record.status = status;

  const contact = plain(page.properties, "聯絡方式");
  const bodyPhone = typeof base.phone === "string" ? base.phone : undefined;
  const bodyLine = typeof base.lineId === "string" ? base.lineId : undefined;
  if (contact !== formatContact(bodyPhone, bodyLine) || (bodyPhone === undefined && bodyLine === undefined)) {
    const parsed = parseContact(contact);
    record.phone = parsed.phone;
    record.lineId = parsed.lineId;
  }

  const commitment = plain(page.properties, "承諾內容／下一步");
  const bodyProduct = typeof base.productType === "string" ? base.productType : undefined;
  const bodyQuantity = base.quantity as number | string | undefined;
  if (
    commitment !== formatCommitment(bodyProduct, bodyQuantity) ||
    (bodyProduct === undefined && bodyQuantity === undefined)
  ) {
    const parsed = parseCommitment(commitment);
    record.productType = parsed.productType;
    if (parsed.quantity !== undefined) {
      record.quantity = /^-?\d+(\.\d+)?$/.test(parsed.quantity) ? Number(parsed.quantity) : parsed.quantity;
    } else {
      delete record.quantity;
    }
  }

  if (page.last_edited_time) record.updatedAt = page.last_edited_time;
  return record;
}

export interface CodeBlock {
  object: "block";
  type: "code";
  code: { language: "json"; rich_text: RichText[] };
}

export function recordToCodeBlocks(record: unknown): CodeBlock[] {
  const json = JSON.stringify(record);
  const chunks = richText(json);
  const blocks: CodeBlock[] = [];
  const source = chunks.length > 0 ? chunks : richText("{}");
  for (let i = 0; i < source.length; i += 100) {
    blocks.push({
      object: "block",
      type: "code",
      code: { language: "json", rich_text: source.slice(i, i + 100) },
    });
  }
  return blocks;
}

export function codeBlocksToJson(blocks: unknown[]): unknown | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; code?: { language?: string; rich_text?: unknown } };
    if (record.type !== "code") continue;
    if (record.code?.language && record.code.language !== "json") continue;
    parts.push(textItems(record.code?.rich_text));
  }
  if (parts.length === 0) return null;
  try {
    return JSON.parse(parts.join(""));
  } catch {
    return null;
  }
}

export function monthRange(month: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("invalid month");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const start = `${match[1]}-${match[2]}-01`;
  const end =
    monthNumber === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  return { start, end };
}

export function ledgerQueryFilter(month?: string): Record<string, unknown> {
  const externalId = { property: "外部ID", rich_text: { is_not_empty: true } };
  if (!month) return externalId;
  const range = monthRange(month);
  return {
    and: [
      externalId,
      { property: "日期", date: { on_or_after: range.start } },
      { property: "日期", date: { before: range.end } },
    ],
  };
}

export interface RateGate {
  wait(): Promise<void>;
}

export function createRateGate(
  gapMs = MIN_GAP_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = () => Date.now(),
): RateGate {
  let chain: Promise<void> = Promise.resolve();
  let nextSlot = 0;
  return {
    async wait() {
      const ticket = chain.then(async () => {
        const start = Math.max(now(), nextSlot);
        nextSlot = start + gapMs;
        const delay = start - now();
        if (delay > 0) await sleep(delay);
      });
      chain = ticket.then(
        () => undefined,
        () => undefined,
      );
      await ticket;
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Schedule state only. Request payloads and tokens stay on the request. */
let sharedGate: RateGate | undefined;

export function getSharedGate(): RateGate {
  if (!sharedGate) sharedGate = createRateGate();
  return sharedGate;
}

export interface NotionDeps {
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  gate: RateGate;
}

interface NotionResponse {
  results?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
  [key: string]: unknown;
}

async function notionRequest(deps: NotionDeps, path: string, method: string, body?: unknown): Promise<NotionResponse> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await deps.gate.wait();
    let response: Response;
    try {
      response = await deps.fetch(`${NOTION_API}${path}`, {
        method,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${deps.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NotionRequestError(0);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new NotionRequestError(response.status);
    }
    if (response.status === 429 && attempt < maxAttempts - 1) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await deps.sleep(waitMs);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      console.error(JSON.stringify({ message: "notion request failed", status: response.status, path }));
      throw new NotionRequestError(response.status);
    }
    if (!text) return {};
    return JSON.parse(text) as NotionResponse;
  }
  throw new NotionRequestError(429);
}

async function queryAll(deps: NotionDeps, databaseId: string, filter: Record<string, unknown>): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(deps, `/databases/${databaseId}/query`, "POST", body);
    for (const item of data.results ?? []) {
      if (item && typeof item === "object") pages.push(item as NotionPage);
    }
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function queryByExternalId(deps: NotionDeps, databaseId: string, externalId: string): Promise<NotionPage[]> {
  const data = await notionRequest(deps, `/databases/${databaseId}/query`, "POST", {
    page_size: 1,
    filter: { property: "外部ID", rich_text: { equals: externalId } },
  });
  return (data.results ?? []).filter((item): item is NotionPage => !!item && typeof item === "object");
}

async function listChildren(deps: NotionDeps, blockId: string): Promise<unknown[]> {
  const blocks: unknown[] = [];
  let cursor: string | undefined;
  do {
    const query = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : "?page_size=100";
    const data = await notionRequest(deps, `/blocks/${blockId}/children${query}`, "GET");
    blocks.push(...(data.results ?? []));
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function replaceJsonCodeBlocks(deps: NotionDeps, pageId: string, blocks: CodeBlock[]): Promise<void> {
  const existing = await listChildren(deps, pageId);
  for (const block of existing) {
    if (!block || typeof block !== "object") continue;
    const record = block as { id?: string; type?: string; code?: { language?: string } };
    if (record.type === "code" && record.code?.language === "json" && record.id) {
      await notionRequest(deps, `/blocks/${record.id}`, "PATCH", { archived: true });
    }
  }
  if (blocks.length > 0) {
    await notionRequest(deps, `/blocks/${pageId}/children`, "PATCH", { children: blocks });
  }
}

export async function listLedger(deps: NotionDeps, databaseId: string, month?: string): Promise<LedgerTx[]> {
  const pages = await queryAll(deps, databaseId, ledgerQueryFilter(month));
  return pages.flatMap((page) => {
    const tx = notionPageToLedgerTx(page);
    return tx ? [tx] : [];
  });
}

export async function upsertLedgerTx(deps: NotionDeps, databaseId: string, tx: LedgerTx): Promise<LedgerTx> {
  const properties = ledgerTxToProperties(tx);
  const existing = await queryByExternalId(deps, databaseId, tx.id);
  const saved = existing[0]
    ? await notionRequest(deps, `/pages/${existing[0].id}`, "PATCH", { properties })
    : await notionRequest(deps, "/pages", "POST", { parent: { database_id: databaseId }, properties });
  return notionPageToLedgerTx(saved as unknown as NotionPage) ?? { ...tx, updatedAt: tx.updatedAt };
}

export async function softDeleteLedgerTx(deps: NotionDeps, databaseId: string, id: string): Promise<LedgerTx | null> {
  const existing = await queryByExternalId(deps, databaseId, id);
  const page = existing[0];
  if (!page) return null;
  const saved = await notionRequest(deps, `/pages/${page.id}`, "PATCH", {
    properties: { 已刪除: { checkbox: true } },
  });
  const parsed = notionPageToLedgerTx(saved as unknown as NotionPage);
  if (parsed) return parsed;
  const fallback = notionPageToLedgerTx(page);
  if (!fallback) return null;
  const edited = typeof saved.last_edited_time === "string" ? saved.last_edited_time : fallback.updatedAt;
  return { ...fallback, deleted: true, updatedAt: edited };
}

export async function listCrm(deps: NotionDeps, databaseId: string): Promise<CrmRecord[]> {
  const pages = await queryAll(deps, databaseId, { property: "外部ID", rich_text: { is_not_empty: true } });
  const records: CrmRecord[] = [];
  for (const page of pages) {
    const blocks = await listChildren(deps, page.id);
    const record = notionPageToCrmRecord(page, codeBlocksToJson(blocks));
    if (record) records.push(record);
  }
  return records;
}

export async function upsertCrmRecord(deps: NotionDeps, databaseId: string, record: CrmRecord): Promise<CrmRecord> {
  const existing = await queryByExternalId(deps, databaseId, record.inquiryId);
  const properties = crmRecordToProperties(record);
  const children = recordToCodeBlocks(record);
  if (!existing[0]) {
    const created = await notionRequest(deps, "/pages", "POST", {
      parent: { database_id: databaseId },
      properties,
      children,
    });
    return notionPageToCrmRecord(created as unknown as NotionPage, record) ?? record;
  }
  const pageId = existing[0].id;
  const updated = await notionRequest(deps, `/pages/${pageId}`, "PATCH", { properties });
  await replaceJsonCodeBlocks(deps, pageId, children);
  return notionPageToCrmRecord(updated as unknown as NotionPage, record) ?? record;
}

export interface NotionGatewayOptions {
  token: string;
  ledgerDb: string;
  crmDb: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  gate?: RateGate;
}

export function createNotionGateway(options: NotionGatewayOptions) {
  const deps: NotionDeps = {
    token: options.token,
    fetch: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    sleep: options.sleep ?? defaultSleep,
    gate: options.gate ?? getSharedGate(),
  };
  return {
    listLedger: (month?: string) => listLedger(deps, options.ledgerDb, month),
    upsertLedger: (tx: LedgerTx) => upsertLedgerTx(deps, options.ledgerDb, tx),
    softDeleteLedger: (id: string) => softDeleteLedgerTx(deps, options.ledgerDb, id),
    bulkLedger: async (txs: LedgerTx[]) => {
      const saved: LedgerTx[] = [];
      for (const tx of txs) saved.push(await upsertLedgerTx(deps, options.ledgerDb, tx));
      return saved;
    },
    listCrm: () => listCrm(deps, options.crmDb),
    upsertCrm: (record: CrmRecord) => upsertCrmRecord(deps, options.crmDb, record),
    bulkCrm: async (records: CrmRecord[]) => {
      const saved: CrmRecord[] = [];
      for (const record of records) saved.push(await upsertCrmRecord(deps, options.crmDb, record));
      return saved;
    },
  };
}
