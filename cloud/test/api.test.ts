import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/handler";
import { ASSISTANT, asAssistant, asReader, NOW, ownerCookie, PASSWORD, readerCookie, testEnv } from "./helpers";
import { createTestDb } from "./sqlite";

const txBody = {
  id: "tx_example_malt",
  date: "2026-11-03",
  type: "expense",
  entity: "yapi",
  category: "原料-麥芽",
  amount: "22.5",
  hasInvoice: true,
  note: "EXAMPLE 麥芽",
};

async function seed(db: ReturnType<typeof createTestDb>) {
  const first = await handleApi(
    asAssistant("/api/v1/transactions", { method: "POST", body: JSON.stringify(txBody) }, "idem-example-malt-01"),
    testEnv(),
    { db, now: NOW },
  );
  expect(first.status).toBe(201);
  const personal = await handleApi(
    asAssistant(
      "/api/v1/transactions",
      {
        method: "POST",
        body: JSON.stringify({
          id: "tx_example_personal",
          date: "2026-11-04",
          type: "expense",
          entity: "personal",
          category: "日常生活支出",
          amountCents: 100,
          hasInvoice: false,
          note: "EXAMPLE 個人",
        }),
      },
      "idem-example-personal-01",
    ),
    testEnv(),
    { db, now: NOW },
  );
  expect(personal.status).toBe(201);
  const income = await handleApi(
    asAssistant(
      "/api/v1/transactions",
      {
        method: "POST",
        body: JSON.stringify({
          id: "tx_example_income",
          date: "2026-11-05",
          type: "income",
          entity: "yapi",
          category: "代工收入",
          amountCents: 2250,
          hasInvoice: true,
          note: "EXAMPLE 代工",
        }),
      },
      "idem-example-income-01",
    ),
    testEnv(),
    { db, now: NOW },
  );
  expect(income.status).toBe(201);
}

describe("authentication and authorization", () => {
  it("denies unauthenticated finance reads and writes", async () => {
    const db = createTestDb();
    const response = await handleApi(new Request("https://blue.test/api/v1/transactions"), testEnv(), { db, now: NOW });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    const write = await handleApi(
      new Request("https://blue.test/api/v1/transactions", { method: "POST", body: JSON.stringify(txBody) }),
      testEnv(),
      { db, now: NOW },
    );
    expect(write.status).toBe(401);
  });

  it("rejects a bad origin and answers preflight only for an allowed origin", async () => {
    const db = createTestDb();
    const denied = await handleApi(
      new Request("https://blue.test/api/v1/transactions", { headers: { Origin: "https://evil.example" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await handleApi(
      new Request("https://blue.test/api/v1/transactions", {
        method: "OPTIONS",
        headers: { Origin: "https://blue.test", "Access-Control-Request-Headers": "authorization" },
      }),
      testEnv(),
      { db, now: NOW },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://blue.test");
  });

  it("gives the phone a reader session and refuses writer routes", async () => {
    const db = createTestDb();
    const cookie = await readerCookie(db);
    const session = await handleApi(asReader("/api/v1/session", cookie), testEnv(), { db, now: NOW });
    expect(await session.json()).toMatchObject({ ok: true, role: "reader" });
    const write = await handleApi(
      asReader("/api/v1/transactions", cookie, { method: "POST", body: JSON.stringify(txBody), headers: { "Idempotency-Key": "idem-reader-no-01" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(write.status).toBe(403);
    const apply = await handleApi(
      asReader("/api/v1/migration/apply", cookie, { method: "POST", body: JSON.stringify({ txs: [] }), headers: { "Idempotency-Key": "idem-reader-apply" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(apply.status).toBe(403);
  });

  it("lets the assistant read and write but not export, audit, or apply a migration", async () => {
    const db = createTestDb();
    await seed(db);
    const read = await handleApi(asAssistant("/api/v1/transactions/tx_example_malt"), testEnv(), { db, now: NOW });
    expect(read.status).toBe(200);
    const body = await read.json() as { tx: { amountCents: number; amount: string } };
    expect(body.tx.amountCents).toBe(2250);
    expect(body.tx.amount).toBe("22.50");
    const exported = await handleApi(asAssistant("/api/v1/export"), testEnv(), { db, now: NOW });
    expect(exported.status).toBe(403);
    const audit = await handleApi(asAssistant("/api/v1/audit"), testEnv(), { db, now: NOW });
    expect(audit.status).toBe(403);
    const apply = await handleApi(
      asAssistant("/api/v1/migration/apply", { method: "POST", body: JSON.stringify({ txs: [] }) }, "idem-assistant-apply"),
      testEnv(),
      { db, now: NOW },
    );
    expect(apply.status).toBe(403);
    const cookie = await readerCookie(db);
    const ownerOnly = await handleApi(asReader("/api/v1/export", cookie), testEnv(), { db, now: NOW });
    expect(ownerOnly.status).toBe(200);
  });

  it("does not treat a short numeric password as configured", async () => {
    const db = createTestDb();
    const health = await handleApi(new Request("https://blue.test/api/v1/health"), testEnv({ OWNER_PASSWORD: "1234" }), { db, now: NOW });
    const body = await health.json() as { ready: boolean; ownerAuthConfigured: boolean; canonicalClaim: string; notionSyncClaim: string };
    expect(body.ready).toBe(false);
    expect(body.ownerAuthConfigured).toBe(false);
    expect(body.canonicalClaim).toBe("none");
    expect(body.notionSyncClaim).toBe("none");
    const login = await handleApi(
      new Request("https://blue.test/api/v1/session", { method: "POST", body: JSON.stringify({ password: "1234" }) }),
      testEnv({ OWNER_PASSWORD: "1234" }),
      { db, now: NOW },
    );
    expect(login.status).toBe(503);
  });

  it("locks repeated login failures and never echoes the password", async () => {
    const db = createTestDb();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await handleApi(
        new Request("https://blue.test/api/v1/session", { method: "POST", body: JSON.stringify({ password: "wrong-passphrase-value" }) }),
        testEnv(),
        { db, now: NOW },
      );
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(PASSWORD);
    }
    const locked = await handleApi(
      new Request("https://blue.test/api/v1/session", { method: "POST", body: JSON.stringify({ password: PASSWORD }) }),
      testEnv(),
      { db, now: NOW },
    );
    expect(locked.status).toBe(429);
  });

  it("scrubs secrets from unexpected failures", async () => {
    const db = createTestDb();
    const cookie = await readerCookie(db);
    const exploding = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            throw new Error(`boom ${PASSWORD} ${ASSISTANT}`);
          },
          async first() {
            throw new Error(`boom ${PASSWORD}`);
          },
          async run() {
            throw new Error(`boom ${ASSISTANT}`);
          },
        };
      },
    };
    const response = await handleApi(asReader("/api/v1/transactions", cookie), testEnv(), { db: exploding, now: NOW });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(ASSISTANT);
    expect(text).toContain("internal_error");
  });
});

describe("writes, money, conflicts", () => {
  it("stores 22.5 TWD as 2250 minor units and replays the same idempotency key", async () => {
    const db = createTestDb();
    const first = await handleApi(
      asAssistant("/api/v1/transactions", { method: "POST", body: JSON.stringify({ ...txBody, amountCents: 2250 }) }, "idem-retry-225"),
      testEnv(),
      { db, now: NOW },
    );
    expect(first.status).toBe(201);
    const second = await handleApi(
      asAssistant("/api/v1/transactions", { method: "POST", body: JSON.stringify({ ...txBody, amountCents: 2250 }) }, "idem-retry-225"),
      testEnv(),
      { db, now: NOW },
    );
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    const cookie = await readerCookie(db);
    const list = await handleApi(asReader("/api/v1/transactions", cookie), testEnv(), { db, now: NOW });
    const body = await list.json() as { transactions: Array<{ id: string }> };
    expect(body.transactions.filter((row) => row.id === "tx_example_malt")).toHaveLength(1);
  });

  it("rejects the same idempotency key with a different body", async () => {
    const db = createTestDb();
    await handleApi(asAssistant("/api/v1/transactions", { method: "POST", body: JSON.stringify(txBody) }, "idem-conflict-body"), testEnv(), { db, now: NOW });
    const changed = await handleApi(
      asAssistant("/api/v1/transactions", { method: "POST", body: JSON.stringify({ ...txBody, note: "EXAMPLE changed" }) }, "idem-conflict-body"),
      testEnv(),
      { db, now: NOW },
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "idempotency_conflict" });
  });

  it("keeps omitted fields on update and refuses a stale version", async () => {
    const db = createTestDb();
    await seed(db);
    const cookie = await readerCookie(db);
    const current = await (await handleApi(asReader("/api/v1/transactions/tx_example_malt", cookie), testEnv(), { db, now: NOW })).json() as { tx: { version: number; note: string } };
    const conflict = await handleApi(
      asAssistant(
        "/api/v1/transactions/tx_example_malt",
        { method: "PUT", body: JSON.stringify({ expectedVersion: 99, note: "EXAMPLE should not stick" }) },
        "idem-stale-version",
      ),
      testEnv(),
      { db, now: NOW },
    );
    expect(conflict.status).toBe(409);
    const afterConflict = await (await handleApi(asReader("/api/v1/transactions/tx_example_malt", cookie), testEnv(), { db, now: NOW })).json() as { tx: { note: string; version: number } };
    expect(afterConflict.tx.note).toBe("EXAMPLE 麥芽");
    expect(afterConflict.tx.version).toBe(current.tx.version);
    const updated = await handleApi(
      asAssistant(
        "/api/v1/transactions/tx_example_malt",
        { method: "PUT", body: JSON.stringify({ expectedVersion: current.tx.version, amount: "10.25" }) },
        "idem-partial-update",
      ),
      testEnv(),
      { db, now: NOW },
    );
    expect(updated.status).toBe(200);
    const saved = await updated.json() as { tx: { amountCents: number; note: string; version: number } };
    expect(saved.tx.amountCents).toBe(1025);
    expect(saved.tx.note).toBe("EXAMPLE 麥芽");
    expect(saved.tx.version).toBe(current.tx.version + 1);
  });

  it("flags a different id with the same payload instead of inserting it", async () => {
    const db = createTestDb();
    await seed(db);
    const duplicate = await handleApi(
      asAssistant(
        "/api/v1/transactions",
        {
          method: "POST",
          body: JSON.stringify({ ...txBody, id: "tx_example_malt_copy" }),
        },
        "idem-dup-content",
      ),
      testEnv(),
      { db, now: NOW },
    );
    expect(duplicate.status).toBe(409);
    const body = await duplicate.json() as { error: string; preserved: boolean; details: { existing: { id: string }; incoming: { id: string } } };
    expect(body.error).toBe("duplicate_suspected");
    expect(body.preserved).toBe(true);
    expect(body.details.existing.id).toBe("tx_example_malt");
    expect(body.details.incoming.id).toBe("tx_example_malt_copy");
    const cookie = await readerCookie(db);
    const list = await (await handleApi(asReader("/api/v1/transactions", cookie), testEnv(), { db, now: NOW })).json() as { transactions: Array<{ id: string }> };
    expect(list.transactions.some((row) => row.id === "tx_example_malt_copy")).toBe(false);
  });

  it("rejects bad entity, category, date, and inexact money", async () => {
    const db = createTestDb();
    const response = await handleApi(
      asAssistant(
        "/api/v1/transactions",
        {
          method: "POST",
          body: JSON.stringify({ ...txBody, id: "tx_example_bad", entity: "nope", category: "不存在", date: "2026-02-31", amount: "22.555" }),
        },
        "idem-invalid-row",
      ),
      testEnv(),
      { db, now: NOW },
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { details: { fields: Record<string, string> } };
    expect(body.details.fields.entity).toBe("invalid");
    expect(body.details.fields.category).toBe("not_in_catalog");
    expect(body.details.fields.date).toBe("invalid");
    expect(body.details.fields.amount).toBe("invalid");
  });
});

describe("stats and obligations", () => {
  it("excludes personal from the business net and keeps obligations out of cash net", async () => {
    const db = createTestDb();
    await seed(db);
    const obligation = await handleApi(
      asAssistant(
        "/api/v1/obligations",
        {
          method: "POST",
          body: JSON.stringify({
            entity: "yapi",
            item: "房租",
            cycle: null,
            billed: "1000.50",
            paidCents: null,
            dueDate: null,
            futureMonthly: "1000.50",
            note: "EXAMPLE 未知到期",
            enabled: true,
          }),
        },
        "idem-obligation-rent",
      ),
      testEnv(),
      { db, now: NOW },
    );
    expect(obligation.status).toBe(201);
    const saved = await obligation.json() as { obligation: { dueDate: null; paidCents: null; futureMonthlyCents: number; paid: null } };
    expect(saved.obligation.dueDate).toBeNull();
    expect(saved.obligation.paidCents).toBeNull();
    expect(saved.obligation.paid).toBeNull();
    expect(saved.obligation.futureMonthlyCents).toBe(100050);
    const cookie = await readerCookie(db);
    const stats = await handleApi(asReader("/api/v1/stats?from=2026-11-01&to=2026-11-30", cookie), testEnv(), { db, now: NOW });
    const body = await stats.json() as {
      stats: {
        business: { incomeCents: number; expenseCents: number; netCents: number };
        personal: { expenseCents: number; netCents: number };
        all: { netCents: number };
        cashNetIsProfit: boolean;
        obligations: { includedInCashNet: boolean; knownFutureMonthlyCents: number; unknownDue: number; unknownPaid: number };
      };
    };
    expect(body.stats.business).toEqual({ incomeCents: 2250, expenseCents: 2250, netCents: 0, count: 2 });
    expect(body.stats.personal.netCents).toBe(-100);
    expect(body.stats.all.netCents).toBe(-100);
    expect(body.stats.cashNetIsProfit).toBe(false);
    expect(body.stats.obligations.includedInCashNet).toBe(false);
    expect(body.stats.obligations.knownFutureMonthlyCents).toBe(100050);
    expect(body.stats.obligations.unknownDue).toBe(1);
    expect(body.stats.obligations.unknownPaid).toBe(1);
    expect(body.stats.business.netCents).not.toBe(body.stats.business.incomeCents - body.stats.business.expenseCents - 100050);
  });
});

describe("migration and restore", () => {
  it("dry-runs and applies without dropping canonical-only rows or overwriting conflicts", async () => {
    const db = createTestDb();
    await seed(db);
    const owner = await ownerCookie(db);
    const file = {
      version: "0.1",
      exportedAt: "2026-11-08T00:00:00.000Z",
      txs: [
        { ...txBody, amount: 22.5, createdAt: null },
        {
          id: "tx_example_malt",
          date: "2026-11-03",
          type: "expense",
          entity: "yapi",
          category: "原料-麥芽",
          amount: 99,
          hasInvoice: true,
          note: "EXAMPLE divergent",
          createdAt: null,
        },
        {
          id: "tx_example_new",
          date: "2026-11-06",
          type: "income",
          entity: "kaipi",
          category: "餐飲收入",
          amount: 3.5,
          hasInvoice: false,
          note: "EXAMPLE new",
          createdAt: 1_700_000_000_000,
        },
        {
          id: "tx_example_void",
          date: "2026-11-01",
          type: "expense",
          entity: "beerwang",
          category: "雜支",
          amount: 1,
          hasInvoice: false,
          note: "EXAMPLE void",
          deleted: true,
        },
      ],
    };
    const dry = await handleApi(
      asReader("/api/v1/migration/dry-run", owner, { method: "POST", body: JSON.stringify(file) }),
      testEnv(),
      { db, now: NOW },
    );
    expect(dry.status).toBe(200);
    const blocked = await dry.json() as { applyAllowed: boolean; wrote: boolean };
    expect(blocked.wrote).toBe(false);
    expect(blocked.applyAllowed).toBe(false);
    const refused = await handleApi(
      asReader("/api/v1/migration/apply", owner, { method: "POST", body: JSON.stringify(file), headers: { "Idempotency-Key": "idem-refuse-file-conflict" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "migration_invalid", details: { liveRowsDeleted: 0, liveRowsOverwritten: 0 } });
    const cleaned = {
      ...file,
      txs: file.txs.filter((row) => row.note !== "EXAMPLE divergent"),
    };
    const preview = await handleApi(
      asReader("/api/v1/migration/compare", owner, { method: "POST", body: JSON.stringify(cleaned) }),
      testEnv(),
      { db, now: NOW },
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as {
      wrote: boolean;
      cutover: string;
      phoneCompleteness: string;
      counts: { identical: number; onlyInCanonical: number; onlyInCandidate: number };
      onlyInCanonicalIds: string[];
    };
    expect(previewBody.wrote).toBe(false);
    expect(previewBody.cutover).toBe("not_performed");
    expect(previewBody.phoneCompleteness).toBe("unknown");
    expect(previewBody.counts.identical).toBe(1);
    expect(previewBody.onlyInCanonicalIds).toEqual(expect.arrayContaining(["tx_example_personal", "tx_example_income"]));
    const before = await (await handleApi(asReader("/api/v1/transactions?includeVoided=1", owner), testEnv(), { db, now: NOW })).json() as { transactions: unknown[] };
    const applied = await handleApi(
      asReader("/api/v1/migration/apply", owner, { method: "POST", body: JSON.stringify(cleaned), headers: { "Idempotency-Key": "idem-apply-example-01" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(applied.status).toBe(200);
    const appliedBody = await applied.json() as { transactions: { inserted: number; identical: number; conflicts: number }; liveRowsDeleted: number; liveRowsOverwritten: number };
    expect(appliedBody.transactions.inserted).toBe(2);
    expect(appliedBody.transactions.identical).toBe(1);
    expect(appliedBody.transactions.conflicts).toBe(0);
    expect(appliedBody.liveRowsDeleted).toBe(0);
    expect(appliedBody.liveRowsOverwritten).toBe(0);
    const after = await (await handleApi(asReader("/api/v1/transactions?includeVoided=1&limit=20", owner), testEnv(), { db, now: NOW })).json() as { transactions: Array<{ id: string; note: string; voided: boolean; amountCents: number; createdAtMs: number | null }> };
    expect(after.transactions.length).toBe(before.transactions.length + 2);
    expect(after.transactions.find((row) => row.id === "tx_example_malt")?.note).toBe("EXAMPLE 麥芽");
    expect(after.transactions.find((row) => row.id === "tx_example_new")).toMatchObject({ amountCents: 350, createdAtMs: 1_700_000_000_000 });
    expect(after.transactions.find((row) => row.id === "tx_example_void")?.voided).toBe(true);
    const visible = await (await handleApi(asReader("/api/v1/transactions", owner), testEnv(), { db, now: NOW })).json() as { transactions: Array<{ id: string }> };
    expect(visible.transactions.some((row) => row.id === "tx_example_void")).toBe(false);
    const divergent = {
      version: "0.1",
      txs: [{ ...txBody, amount: 40, note: "EXAMPLE other payload", createdAt: null }],
    };
    const conflictApply = await handleApi(
      asReader("/api/v1/migration/apply", owner, { method: "POST", body: JSON.stringify(divergent), headers: { "Idempotency-Key": "idem-apply-conflict-01" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(conflictApply.status).toBe(200);
    const conflictBody = await conflictApply.json() as { transactions: { conflicts: number; inserted: number; reviewIds: number[] } };
    expect(conflictBody.transactions.conflicts).toBe(1);
    expect(conflictBody.transactions.inserted).toBe(0);
    const still = await (await handleApi(asReader("/api/v1/transactions/tx_example_malt", owner), testEnv(), { db, now: NOW })).json() as { tx: { note: string; amountCents: number } };
    expect(still.tx.note).toBe("EXAMPLE 麥芽");
    expect(still.tx.amountCents).toBe(2250);
    const review = await (await handleApi(asReader("/api/v1/review", owner), testEnv(), { db, now: NOW })).json() as { review: Array<{ existing: { note: string }; incoming: { note: string } }> };
    expect(review.review.some((item) => item.existing.note === "EXAMPLE 麥芽" && item.incoming.note === "EXAMPLE other payload")).toBe(true);
    const again = await handleApi(
      asReader("/api/v1/migration/apply", owner, { method: "POST", body: JSON.stringify(divergent), headers: { "Idempotency-Key": "idem-apply-conflict-02" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(again.status).toBe(200);
    const reviewAgain = await (await handleApi(asReader("/api/v1/review", owner), testEnv(), { db, now: NOW })).json() as { review: unknown[] };
    expect(reviewAgain.review).toHaveLength(review.review.length);
  });

  it("stages a restore without touching live rows, then commits only missing ids", async () => {
    const db = createTestDb();
    await seed(db);
    const owner = await ownerCookie(db);
    const payload = {
      version: "tonic-blue-1",
      transactions: [
        {
          id: "tx_example_malt",
          date: "2026-11-03",
          type: "expense",
          entity: "yapi",
          category: "原料-麥芽",
          amountCents: 1,
          amount: "0.01",
          hasInvoice: true,
          note: "EXAMPLE staged conflict",
          createdAt: null,
          createdAtMs: null,
          voided: false,
        },
        {
          id: "tx_example_restore",
          date: "2026-11-07",
          type: "income",
          entity: "taros",
          category: "設備銷售",
          amountCents: 500,
          amount: "5.00",
          hasInvoice: true,
          note: "EXAMPLE restore",
          createdAt: null,
          createdAtMs: null,
          voided: false,
        },
      ],
    };
    const staged = await handleApi(
      asReader("/api/v1/restore/stage", owner, { method: "POST", body: JSON.stringify(payload), headers: { "Idempotency-Key": "idem-stage-example-01" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(staged.status).toBe(200);
    const stagedBody = await staged.json() as { liveTransactionsUnchanged: boolean; batchId: string };
    expect(stagedBody.liveTransactionsUnchanged).toBe(true);
    const during = await (await handleApi(asReader("/api/v1/transactions/tx_example_malt", owner), testEnv(), { db, now: NOW })).json() as { tx: { amountCents: number } };
    expect(during.tx.amountCents).toBe(2250);
    const committed = await handleApi(
      asReader(`/api/v1/restore/${stagedBody.batchId}/commit`, owner, { method: "POST", body: JSON.stringify({}), headers: { "Idempotency-Key": "idem-commit-example-01" } }),
      testEnv(),
      { db, now: NOW },
    );
    expect(committed.status).toBe(200);
    const malt = await (await handleApi(asReader("/api/v1/transactions/tx_example_malt", owner), testEnv(), { db, now: NOW })).json() as { tx: { amountCents: number } };
    expect(malt.tx.amountCents).toBe(2250);
    const restored = await (await handleApi(asReader("/api/v1/transactions/tx_example_restore", owner), testEnv(), { db, now: NOW })).json() as { tx: { amountCents: number } };
    expect(restored.tx.amountCents).toBe(500);
  });

  it("refuses an inexact amount without writing", async () => {
    const db = createTestDb();
    await seed(db);
    const owner = await ownerCookie(db);
    const before = await (await handleApi(asReader("/api/v1/transactions?includeVoided=1", owner), testEnv(), { db, now: NOW })).json() as { transactions: unknown[] };
    const response = await handleApi(
      asReader("/api/v1/migration/apply", owner, {
        method: "POST",
        body: JSON.stringify({ txs: [{ id: "tx_example_bad_cents", date: "2026-11-01", type: "expense", entity: "yapi", category: "雜支", amount: 1.005, hasInvoice: false, note: "EXAMPLE" }] }),
        headers: { "Idempotency-Key": "idem-bad-cents" },
      }),
      testEnv(),
      { db, now: NOW },
    );
    expect(response.status).toBe(400);
    const after = await (await handleApi(asReader("/api/v1/transactions?includeVoided=1", owner), testEnv(), { db, now: NOW })).json() as { transactions: unknown[] };
    expect(after.transactions).toHaveLength(before.transactions.length);
  });
});

describe("source safety", () => {
  it("has no ledger delete statement", () => {
    const files = ["db.ts", "workflows.ts", "handler.ts"].map((name) => readFileSync(`${import.meta.dirname}/../src/${name}`, "utf8"));
    for (const source of files) {
      expect(source).not.toMatch(/DELETE\s+FROM\s+transactions/i);
      expect(source).not.toMatch(/DELETE\s+FROM\s+obligations/i);
      expect(source).not.toMatch(/DELETE\s+FROM\s+review_items/i);
      expect(source).not.toMatch(/DELETE\s+FROM\s+audit_log/i);
    }
  });
});
