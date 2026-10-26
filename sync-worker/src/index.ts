import {
  createNotionGateway,
  type CrmRecord,
  type LedgerTx,
  NotionRequestError,
  type RateGate,
} from "./notion";
import { corsHeaders, parseAllowedOrigins, scrub, secretEquals } from "./guard";

export interface SyncEnv {
  NOTION_TOKEN: string;
  APP_PIN: string;
  NOTION_LEDGER_DB: string;
  NOTION_CRM_DB: string;
  ALLOWED_ORIGINS?: string;
}

export interface RequestDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  gate?: RateGate;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const MAX_BODY_CHARS = 1_500_000;
const MAX_BATCH = 2000;

function json(body: unknown, status: number, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function isMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new HttpError(413, "payload too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid json");
  return value as Record<string, unknown>;
}

export function normalizeLedgerInput(body: unknown, id: string): LedgerTx {
  const raw = asRecord(body);
  if (!id || id.length > 200) throw new HttpError(400, "invalid id");
  if (raw.type !== "income" && raw.type !== "expense") throw new HttpError(400, "invalid type");
  const amount = typeof raw.amount === "number" ? raw.amount : Number(raw.amount);
  if (!Number.isFinite(amount)) throw new HttpError(400, "invalid amount");
  if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
    throw new HttpError(400, "invalid date");
  }
  const tx: LedgerTx = {
    id,
    date: raw.date,
    type: raw.type,
    entity: typeof raw.entity === "string" ? raw.entity : "",
    category: typeof raw.category === "string" ? raw.category : "",
    amount,
    hasInvoice: raw.hasInvoice === true,
    note: typeof raw.note === "string" ? raw.note : "",
    deleted: raw.deleted === true,
  };
  if (typeof raw.updatedAt === "string") tx.updatedAt = raw.updatedAt;
  if (typeof raw.createdAt === "number") tx.createdAt = raw.createdAt;
  return tx;
}

function ledgerList(body: unknown): LedgerTx[] {
  const rows = Array.isArray(body) ? body : asRecord(body).txs;
  if (!Array.isArray(rows)) throw new HttpError(400, "invalid json");
  if (rows.length > MAX_BATCH) throw new HttpError(400, "too many records");
  return rows.map((row) => {
    const record = asRecord(row);
    const id = typeof record.id === "string" ? record.id : "";
    return normalizeLedgerInput(record, id);
  });
}

export function normalizeCrmInput(body: unknown, inquiryId: string): CrmRecord {
  const raw = asRecord(body);
  if (!inquiryId || inquiryId.length > 200) throw new HttpError(400, "invalid id");
  if (raw.status !== undefined && typeof raw.status !== "string") throw new HttpError(400, "invalid status");
  const record: CrmRecord = { ...raw, inquiryId };
  delete record.updatedAt;
  return record;
}

function crmList(body: unknown): CrmRecord[] {
  const rows = Array.isArray(body) ? body : asRecord(body).records;
  if (!Array.isArray(rows)) throw new HttpError(400, "invalid json");
  if (rows.length > MAX_BATCH) throw new HttpError(400, "too many records");
  return rows.map((row) => {
    const record = asRecord(row);
    const id = typeof record.inquiryId === "string" ? record.inquiryId : "";
    return normalizeCrmInput(record, id);
  });
}

function pathId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    throw new HttpError(400, "invalid id");
  }
}

export async function handleRequest(request: Request, env: SyncEnv, deps: RequestDeps = {}): Promise<Response> {
  const origin = request.headers.get("Origin");
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const headers = origin && allowed.includes(origin) ? corsHeaders(origin) : new Headers();
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    if (origin && !allowed.includes(origin)) return json({ ok: false, error: "origin not allowed" }, 403);
    return new Response(null, { status: 204, headers });
  }

  if (origin && !allowed.includes(origin)) {
    return json({ ok: false, error: "origin not allowed" }, 403);
  }

  try {
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, service: "tonic-sync-api" }, 200, headers);
    }

    const authed = await secretEquals(request.headers.get("X-App-Pin") ?? "", env.APP_PIN ?? "");
    if (!authed) return json({ ok: false, error: "unauthorized" }, 401, headers);

    if (!env.NOTION_LEDGER_DB || !env.NOTION_CRM_DB || !env.NOTION_TOKEN) {
      throw new HttpError(500, "internal error");
    }

    const notion = createNotionGateway({
      token: env.NOTION_TOKEN,
      ledgerDb: env.NOTION_LEDGER_DB,
      crmDb: env.NOTION_CRM_DB,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      gate: deps.gate,
    });

    if (request.method === "GET" && path === "/ledger/txs") {
      const month = url.searchParams.get("month");
      if (month !== null && month !== "" && !isMonth(month)) {
        return json({ ok: false, error: "month must be YYYY-MM" }, 400, headers);
      }
      const txs = await notion.listLedger(month || undefined);
      return json({ ok: true, txs }, 200, headers);
    }

    const ledgerId = pathId(path, "/ledger/txs/");
    if (ledgerId && request.method === "PUT") {
      const tx = normalizeLedgerInput(await readJson(request), ledgerId);
      return json({ ok: true, tx: await notion.upsertLedger(tx) }, 200, headers);
    }
    if (ledgerId && request.method === "DELETE") {
      const tx = await notion.softDeleteLedger(ledgerId);
      if (!tx) return json({ ok: false, error: "not found" }, 404, headers);
      return json({ ok: true, id: ledgerId, deleted: true }, 200, headers);
    }
    if (request.method === "POST" && path === "/ledger/bulk") {
      const txs = ledgerList(await readJson(request));
      const saved = await notion.bulkLedger(txs);
      return json({ ok: true, upserted: saved.length, txs: saved }, 200, headers);
    }

    if (request.method === "GET" && path === "/crm/records") {
      return json({ ok: true, records: await notion.listCrm() }, 200, headers);
    }
    const inquiryId = pathId(path, "/crm/records/");
    if (inquiryId && request.method === "PUT") {
      const record = normalizeCrmInput(await readJson(request), inquiryId);
      return json({ ok: true, record: await notion.upsertCrm(record) }, 200, headers);
    }
    if (request.method === "POST" && path === "/crm/bulk") {
      const records = crmList(await readJson(request));
      const saved = await notion.bulkCrm(records);
      return json({ ok: true, upserted: saved.length, records: saved }, 200, headers);
    }

    return json({ ok: false, error: "not found" }, 404, headers);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof NotionRequestError ? 502 : 500;
    const publicError =
      error instanceof HttpError
        ? error.message
        : error instanceof NotionRequestError
          ? "notion request failed"
          : "internal error";
    const detail = scrub(error instanceof Error ? error.message : "unknown", [env.NOTION_TOKEN, env.APP_PIN]);
    console.error(JSON.stringify({ message: "request failed", path, status, error: detail }));
    return json({ ok: false, error: publicError }, status, headers);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
