import {
  assistantTokenConfigured,
  newSessionToken,
  ownerPasswordConfigured,
  scopesFor,
  secretEquals,
  sha256Hex,
  type Scope,
} from "./auth";
import { isMonth, monthRange, taipeiToday } from "./dates";
import {
  bumpRate,
  clearLoginFailures,
  countObligations,
  countTransactions,
  createSession,
  getIdempotency,
  getRestoreBatch,
  getSession,
  getTransaction,
  listAudit,
  listObligations,
  listReview,
  listTransactions,
  loginState,
  publicObligations,
  publicTransactions,
  recordLoginFailure,
  revokeSession,
  saveIdempotency,
  type Database,
} from "./db";
import { HttpError, isRecord, json, readCookie, readJson, resolveCors, scrub, sessionCookie } from "./http";
import { canonicalJson, toPublicTx } from "./model";
import { computeStats, type StatsQuery } from "./stats";
import {
  applyImport,
  commitRestore,
  createObligation,
  createTransaction,
  discardRestore,
  previewImport,
  stageRestore,
  updateObligationFlow,
  updateTransactionFlow,
  type Principal,
} from "./workflows";

export interface AppEnv {
  DB?: unknown;
  OWNER_PASSWORD?: string;
  ASSISTANT_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
  APP_MODE?: string;
  WRITE_RATE_LIMIT?: string;
  READ_RATE_LIMIT?: string;
  LOGIN_LIMIT?: string;
  IP_RATE_LIMIT?: string;
}

export interface HandlerDeps {
  db?: Database;
  now?: () => Date;
}

const SESSION_SECONDS = 12 * 60 * 60;

export async function handleApi(request: Request, env: AppEnv, deps: HandlerDeps = {}): Promise<Response> {
  const requestId = crypto.randomUUID();
  const cors = resolveCors(request, env.ALLOWED_ORIGINS);
  const headers = cors.headers;
  headers.set("X-Request-Id", requestId);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (!cors.ok) return finish(request, path, json({ ok: false, error: "origin_not_allowed" }, 403, headers), requestId);
    if (request.method === "OPTIONS") return finish(request, path, new Response(null, { status: 204, headers: withNoStore(headers) }), requestId);
    if (request.method === "GET" && path === "/api/v1/health") {
      return finish(request, path, json(await healthBody(env, deps.db), 200, headers), requestId);
    }
    const db = deps.db;
    if (!db) throw new HttpError(503, "cloud_unconfigured", { storage: "unbound" });
    if (!ownerPasswordConfigured(env.OWNER_PASSWORD)) throw new HttpError(503, "cloud_unconfigured", { auth: "owner_password" });
    await assertSchema(db);
    const now = deps.now ?? (() => new Date());
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const ipHits = await bumpRate(db, `ip:${(await sha256Hex(ip)).slice(0, 16)}`, now());
    if (ipHits > numberEnv(env.IP_RATE_LIMIT, 180)) throw new HttpError(429, "rate_limited");
    if (request.method === "POST" && path === "/api/v1/session") {
      return finish(request, path, await login(request, env, db, now, url.protocol === "https:", headers), requestId);
    }
    if (request.method === "DELETE" && path === "/api/v1/session") {
      return finish(request, path, await logout(request, db, now, url.protocol === "https:", headers), requestId);
    }
    const principal = await authenticate(request, env, db, now());
    if (request.method === "GET" && path === "/api/v1/session") {
      if (!principal) throw new HttpError(401, "unauthorized");
      return finish(request, path, json({ ok: true, role: principal.role }, 200, headers), requestId);
    }
    if (!principal) throw new HttpError(401, "unauthorized");
    await limit(db, principal, request.method, env, now());
    const response = await route(request, db, principal, path, url, now, headers);
    return finish(request, path, response, requestId);
  } catch (error) {
    const response = errorResponse(error, env, headers);
    return finish(request, path, response, requestId);
  }
}

async function route(
  request: Request,
  db: Database,
  principal: Principal,
  path: string,
  url: URL,
  now: () => Date,
  headers: Headers,
): Promise<Response> {
  if (request.method === "GET" && path === "/api/v1/transactions") {
    requireScope(principal, "read");
    const filter = readTxFilter(url);
    const rows = await listTransactions(db, filter);
    const next = rows.length === filter.limit ? `${rows[rows.length - 1].date}|${rows[rows.length - 1].id}` : null;
    return json({ ok: true, transactions: publicTransactions(rows), nextCursor: next }, 200, headers);
  }
  const txId = pathId(path, "/api/v1/transactions/");
  if (request.method === "GET" && txId) {
    requireScope(principal, "read");
    const tx = await getTransaction(db, txId);
    if (!tx) throw new HttpError(404, "not_found");
    return json({ ok: true, tx: toPublicTx(tx) }, 200, headers);
  }
  if (request.method === "POST" && path === "/api/v1/transactions") {
    requireScope(principal, "write");
    return idempotent(request, db, principal, now(), headers, async (body) => createTransaction(db, principal, body, idempotencyKey(request), now()));
  }
  if (request.method === "PUT" && txId) {
    requireScope(principal, "write");
    return idempotent(request, db, principal, now(), headers, async (body) => updateTransactionFlow(db, principal, txId, body, now()));
  }
  if (request.method === "GET" && path === "/api/v1/stats") {
    requireScope(principal, "read");
    const query = readStatsQuery(url, now());
    const loaded = await listTransactions(db, { from: loadFrom(query), to: query.to, entity: query.entity, scope: query.scope, includeVoided: false, limit: 10000 });
    if (loaded.length >= 10000) throw new HttpError(400, "range_too_wide");
    const obligations = await listObligations(db);
    return json({ ok: true, stats: computeStats(loaded, obligations, query) }, 200, headers);
  }
  if (request.method === "GET" && path === "/api/v1/obligations") {
    requireScope(principal, "read");
    return json({ ok: true, obligations: publicObligations(await listObligations(db)) }, 200, headers);
  }
  if (request.method === "POST" && path === "/api/v1/obligations") {
    requireScope(principal, "obligations");
    return idempotent(request, db, principal, now(), headers, async (body) => createObligation(db, principal, body, idempotencyKey(request), now()));
  }
  const obligationId = pathId(path, "/api/v1/obligations/");
  if (request.method === "PUT" && obligationId) {
    requireScope(principal, "obligations");
    return idempotent(request, db, principal, now(), headers, async (body) => updateObligationFlow(db, principal, obligationId, body, now()));
  }
  if (request.method === "GET" && path === "/api/v1/export") {
    requireScope(principal, "export");
    const transactions = publicTransactions(await listTransactions(db, { includeVoided: true, limit: 20000 }));
    const obligations = publicObligations(await listObligations(db));
    const review = await listReview(db, 2000);
    return json({
      ok: true,
      version: "tonic-blue-1",
      exportedAt: now().toISOString(),
      synthetic: false,
      phoneCompleteness: "unknown",
      notionSyncClaim: "none",
      note: "Cloud backup. This file does not prove the phone or Notion match.",
      transactions,
      obligations,
      review,
    }, 200, headers);
  }
  if (request.method === "GET" && path === "/api/v1/audit") {
    requireScope(principal, "audit");
    return json({ ok: true, audit: await listAudit(db, readLimit(url, 50, 200)) }, 200, headers);
  }
  if (request.method === "GET" && path === "/api/v1/review") {
    requireScope(principal, "read");
    return json({ ok: true, review: await listReview(db, readLimit(url, 100, 500)) }, 200, headers);
  }
  if (request.method === "POST" && (path === "/api/v1/migration/dry-run" || path === "/api/v1/migration/compare" || path === "/api/v1/restore/dry-run")) {
    requireScope(principal, "migrate-preview");
    const body = await readJson(request);
    const preview = await previewImport(db, body);
    return json(preview.body, preview.status, headers);
  }
  if (request.method === "POST" && path === "/api/v1/migration/apply") {
    requireScope(principal, "migrate-apply");
    return idempotent(request, db, principal, now(), headers, async (body) => applyImport(db, principal, body, now()));
  }
  if (request.method === "POST" && path === "/api/v1/restore/stage") {
    requireScope(principal, "restore");
    const key = idempotencyKey(request);
    const id = `restore_${(await sha256Hex(`${principal.actor}:${key}`)).slice(0, 24)}`;
    return idempotent(request, db, principal, now(), headers, async (body) => stageRestore(db, principal, body, now(), id));
  }
  const restoreCommit = path.match(/^\/api\/v1\/restore\/([^/]+)\/commit$/);
  if (request.method === "POST" && restoreCommit) {
    requireScope(principal, "restore");
    const id = decodeId(restoreCommit[1]);
    return idempotent(request, db, principal, now(), headers, async () => commitRestore(db, principal, id, now()));
  }
  const restoreDiscard = path.match(/^\/api\/v1\/restore\/([^/]+)\/discard$/);
  if (request.method === "POST" && restoreDiscard) {
    requireScope(principal, "restore");
    const result = await discardRestore(db, decodeId(restoreDiscard[1]));
    return json(result.body, result.status, headers);
  }
  const restoreGet = path.match(/^\/api\/v1\/restore\/([^/]+)$/);
  if (request.method === "GET" && restoreGet) {
    requireScope(principal, "restore");
    const batch = await getRestoreBatch(db, decodeId(restoreGet[1]));
    if (!batch) throw new HttpError(404, "not_found");
    return json({ ok: true, batch: { id: batch.id, status: batch.status, createdAt: batch.createdAt, summary: batch.summary } }, 200, headers);
  }
  if (request.method === "DELETE") throw new HttpError(405, "method_not_allowed");
  throw new HttpError(404, "not_found");
}

async function login(request: Request, env: AppEnv, db: Database, now: () => Date, secure: boolean, headers: Headers): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body) || typeof body.password !== "string") throw new HttpError(400, "validation_failed", { fields: { password: "invalid" } });
  const limitCount = numberEnv(env.LOGIN_LIMIT, 5);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const bucket = `login:${(await sha256Hex(ip)).slice(0, 16)}`;
  const clock = now();
  if ((await loginState(db, bucket, clock.toISOString())).locked) throw new HttpError(429, "rate_limited");
  const passwordOk = await secretEquals(body.password, env.OWNER_PASSWORD ?? "");
  if (!passwordOk) {
    await recordLoginFailure(db, bucket, clock, limitCount);
    throw new HttpError(401, "unauthorized");
  }
  await clearLoginFailures(db, bucket);
  let role: "reader" | "owner" = "reader";
  if (body.role !== undefined && body.role !== "reader" && body.role !== "owner") {
    throw new HttpError(400, "validation_failed", { fields: { role: "invalid" } });
  }
  if (body.role === "owner") {
    if (request.headers.get("X-Tonic-Owner-Intent") !== "1") throw new HttpError(400, "owner_intent_required");
    role = "owner";
  }
  const token = newSessionToken();
  const createdAt = clock.toISOString();
  const expires = new Date(clock.getTime() + SESSION_SECONDS * 1000).toISOString();
  await createSession(db, await sha256Hex(token), role, createdAt, expires);
  headers.set("Set-Cookie", sessionCookie(token, secure, SESSION_SECONDS));
  return json({ ok: true, role, expiresAt: expires }, 200, headers);
}

async function logout(request: Request, db: Database, now: () => Date, secure: boolean, headers: Headers): Promise<Response> {
  const token = readCookie(request, "tonic_blue_session");
  if (token) await revokeSession(db, await sha256Hex(token), now().toISOString());
  headers.set("Set-Cookie", sessionCookie("", secure, 0));
  return json({ ok: true }, 200, headers);
}

async function authenticate(request: Request, env: AppEnv, db: Database, now: Date): Promise<Principal | null> {
  const authorization = request.headers.get("Authorization");
  const cookie = readCookie(request, "tonic_blue_session");
  if (authorization && cookie) throw new HttpError(400, "ambiguous_auth");
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/.exec(authorization);
    if (!match) throw new HttpError(401, "unauthorized");
    if (!assistantTokenConfigured(env.ASSISTANT_TOKEN)) throw new HttpError(503, "assistant_unconfigured");
    const ok = await secretEquals(match[1], env.ASSISTANT_TOKEN ?? "");
    if (!ok) throw new HttpError(401, "unauthorized");
    const actorHash = await sha256Hex(match[1]);
    return { role: "assistant", actor: `assistant:${actorHash.slice(0, 6)}` };
  }
  if (!cookie) return null;
  const session = await getSession(db, await sha256Hex(cookie), now.toISOString());
  if (!session) throw new HttpError(401, "unauthorized");
  const actorHash = await sha256Hex(cookie);
  return { role: session.role, actor: `${session.role}:${actorHash.slice(0, 6)}` };
}

function requireScope(principal: Principal, scope: Scope): void {
  if (!scopesFor(principal.role).includes(scope)) throw new HttpError(403, "forbidden");
}

async function limit(db: Database, principal: Principal, method: string, env: AppEnv, now: Date): Promise<void> {
  const write = method === "POST" || method === "PUT" || method === "DELETE";
  const cap = write ? numberEnv(env.WRITE_RATE_LIMIT, 60) : numberEnv(env.READ_RATE_LIMIT, 300);
  const hits = await bumpRate(db, `${write ? "write" : "read"}:${principal.actor}`, now);
  if (hits > cap) throw new HttpError(429, "rate_limited");
}

async function idempotent(
  request: Request,
  db: Database,
  principal: Principal,
  now: Date,
  headers: Headers,
  exec: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const key = idempotencyKey(request);
  const raw = await readJson(request);
  if (!isRecord(raw) && raw !== null) throw new HttpError(400, "invalid_json");
  const body = isRecord(raw) ? raw : {};
  const requestHash = await sha256Hex(`${request.method} ${new URL(request.url).pathname} ${canonicalJson(body)}`);
  const existing = await getIdempotency(db, principal.actor, key);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new HttpError(409, "idempotency_conflict");
    headers.set("Idempotent-Replay", "true");
    return json(existing.body, existing.status, headers);
  }
  const result = await exec(body);
  await saveIdempotency(db, {
    actor: principal.actor,
    key,
    requestHash,
    status: result.status,
    body: result.body,
    at: now.toISOString(),
  });
  return json(result.body, result.status, headers);
}

async function healthBody(env: AppEnv, db: Database | undefined) {
  let storage: "unbound" | "ok" | "schema_missing" | "error" = db ? "ok" : "unbound";
  if (db) {
    try {
      await countTransactions(db);
      await countObligations(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      storage = /no such table/i.test(message) ? "schema_missing" : "error";
    }
  }
  const ownerAuthConfigured = ownerPasswordConfigured(env.OWNER_PASSWORD);
  const assistantAuthConfigured = assistantTokenConfigured(env.ASSISTANT_TOKEN);
  return {
    ok: true,
    service: "tonic-blue",
    ready: Boolean(db && ownerAuthConfigured && storage === "ok"),
    storageBinding: Boolean(db),
    storage,
    ownerAuthConfigured,
    assistantAuthConfigured,
    appMode: appMode(env.APP_MODE),
    canonicalClaim: "none",
    notionSyncClaim: "none",
    phoneCompleteness: "unknown",
    observedCountsAreNotSyncProof: true,
  };
}

async function assertSchema(db: Database): Promise<void> {
  try {
    await countTransactions(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/no such table/i.test(message)) throw new HttpError(503, "schema_missing");
    throw error;
  }
}

function readTxFilter(url: URL) {
  const month = url.searchParams.get("month");
  let from = url.searchParams.get("from");
  let to = url.searchParams.get("to");
  if (month) {
    if (!isMonth(month)) throw new HttpError(400, "validation_failed", { fields: { month: "invalid" } });
    const range = monthRange(month)!;
    from = range.from;
    to = range.to;
  }
  if (from && !isDay(from)) throw new HttpError(400, "validation_failed", { fields: { from: "invalid" } });
  if (to && !isDay(to)) throw new HttpError(400, "validation_failed", { fields: { to: "invalid" } });
  const entity = url.searchParams.get("entity");
  const scopeParam = url.searchParams.get("scope") ?? "all";
  if (scopeParam !== "all" && scopeParam !== "business" && scopeParam !== "personal") {
    throw new HttpError(400, "validation_failed", { fields: { scope: "invalid" } });
  }
  const scope: "all" | "business" | "personal" = scopeParam;
  const type = url.searchParams.get("type");
  if (type && type !== "income" && type !== "expense") throw new HttpError(400, "validation_failed", { fields: { type: "invalid" } });
  const cursor = url.searchParams.get("cursor");
  let cursorDate: string | null = null;
  let cursorId: string | null = null;
  if (cursor) {
    const splitAt = cursor.indexOf("|");
    cursorDate = cursor.slice(0, splitAt);
    cursorId = cursor.slice(splitAt + 1);
    if (!isDay(cursorDate) || !cursorId) throw new HttpError(400, "validation_failed", { fields: { cursor: "invalid" } });
  }
  return {
    from,
    to,
    entity,
    scope,
    type: type as "income" | "expense" | null,
    query: url.searchParams.get("q"),
    includeVoided: url.searchParams.get("includeVoided") === "1",
    cursorDate,
    cursorId,
    limit: readLimit(url, 200, 1000),
  };
}

function readStatsQuery(url: URL, now: Date): StatsQuery {
  const month = url.searchParams.get("month");
  let from = url.searchParams.get("from");
  let to = url.searchParams.get("to");
  if (month) {
    if (!isMonth(month)) throw new HttpError(400, "validation_failed", { fields: { month: "invalid" } });
    const range = monthRange(month)!;
    from = range.from;
    to = range.to;
  }
  if (!from || !to) {
    const today = taipeiToday(now);
    from = `${today.slice(0, 7)}-01`;
    to = today;
  }
  if (!isDay(from) || !isDay(to) || from > to) throw new HttpError(400, "validation_failed", { fields: { range: "invalid" } });
  const scopeParam = url.searchParams.get("scope") ?? "all";
  if (scopeParam !== "all" && scopeParam !== "business" && scopeParam !== "personal") {
    throw new HttpError(400, "validation_failed", { fields: { scope: "invalid" } });
  }
  const entity = url.searchParams.get("entity");
  if (entity && !["yapi", "taros", "beerwang", "superhour", "kaipi", "personal"].includes(entity)) {
    throw new HttpError(400, "validation_failed", { fields: { entity: "invalid" } });
  }
  return { from, to, scope: scopeParam, entity };
}

function loadFrom(query: StatsQuery): string {
  const month = query.to.slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1 - 5, 1));
  const trendStart = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const [fromYear, fromMonth, fromDay] = query.from.split("-").map(Number);
  const previousStart = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay));
  const span = Math.round((Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86_400_000) + 1;
  previousStart.setUTCDate(previousStart.getUTCDate() - span);
  const previous = previousStart.toISOString().slice(0, 10);
  return trendStart < previous ? trendStart : previous;
}

function idempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[\w.:-]{8,80}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  return key;
}

function pathId(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest || rest.includes("/")) return null;
  return decodeId(rest);
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "validation_failed", { fields: { id: "invalid" } });
  }
}

function readLimit(url: URL, fallback: number, max: number): number {
  const raw = url.searchParams.get("limit");
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new HttpError(400, "validation_failed", { fields: { limit: "invalid" } });
  return value;
}

function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && monthRange(`${value.slice(0, 7)}`) !== null && value >= `${value.slice(0, 7)}-01` && value <= (monthRange(value.slice(0, 7))?.to ?? "");
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function appMode(value: string | undefined): "unverified" | "local-test" | "production" {
  if (value === "local-test" || value === "production") return value;
  return "unverified";
}

function withNoStore(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.set("Cache-Control", "no-store");
  return copy;
}

function errorResponse(error: unknown, env: AppEnv, headers: Headers): Response {
  if (error instanceof HttpError) {
    return json({ ok: false, error: error.code, ...(error.details ? { details: error.details } : {}) }, error.status, headers);
  }
  const raw = error instanceof Error ? error.message : "unknown";
  console.error(JSON.stringify({ message: "internal", error: scrub(raw, [env.OWNER_PASSWORD, env.ASSISTANT_TOKEN]) }));
  return json({ ok: false, error: "internal_error" }, 500, headers);
}

function finish(request: Request, path: string, response: Response, requestId: string): Response {
  console.log(JSON.stringify({ message: "api", method: request.method, path, status: response.status, requestId }));
  response.headers.set("X-Request-Id", requestId);
  return response;
}
