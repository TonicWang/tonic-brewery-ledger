import { describe, expect, it } from "vitest";
import { handleRequest, type SyncEnv } from "../src/index";
import { createRateGate } from "../src/notion";

const TOKEN = "secret-notion-token-value";
const PIN = "secret-app-pin-value";

function env(overrides: Partial<SyncEnv> = {}): SyncEnv {
  return {
    NOTION_TOKEN: TOKEN,
    APP_PIN: PIN,
    NOTION_LEDGER_DB: "ledger-db",
    NOTION_CRM_DB: "crm-db",
    ALLOWED_ORIGINS: "https://tonicwang.github.io",
    ...overrides,
  };
}

function zeroDeps(fetchImpl?: typeof fetch) {
  return {
    fetchImpl:
      fetchImpl ??
      (async () => {
        throw new Error("notion should not be called");
      }),
    sleep: async () => undefined,
    gate: createRateGate(0, async () => undefined, () => 0),
  };
}

function authed(path: string, init: RequestInit = {}, origin = "https://tonicwang.github.io"): Request {
  const headers = new Headers(init.headers);
  headers.set("X-App-Pin", PIN);
  headers.set("Origin", origin);
  return new Request(`https://sync.example${path}`, { ...init, headers });
}

describe("auth and cors", () => {
  it("returns 401 when the PIN is missing and does not call Notion", async () => {
    const response = await handleRequest(new Request("https://sync.example/ledger/txs"), env(), zeroDeps());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("rejects an origin that is not on the allow list", async () => {
    const response = await handleRequest(
      authed("/ledger/txs", {}, "https://evil.example"),
      env(),
      zeroDeps(),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({ ok: false, error: "origin not allowed" });
  });

  it("echoes only an allowed origin on a preflight", async () => {
    const denied = await handleRequest(
      new Request("https://sync.example/ledger/txs", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example", "Access-Control-Request-Headers": "X-App-Pin" },
      }),
      env(),
      zeroDeps(),
    );
    expect(denied.status).toBe(403);

    const allowed = await handleRequest(
      new Request("https://sync.example/ledger/txs", {
        method: "OPTIONS",
        headers: { Origin: "https://tonicwang.github.io", "Access-Control-Request-Headers": "X-App-Pin" },
      }),
      env(),
      zeroDeps(),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://tonicwang.github.io");
    expect(allowed.headers.get("Access-Control-Allow-Headers")).toContain("X-App-Pin");
  });

  it("never puts secret values in a response", async () => {
    const leakingFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: TOKEN, pin: PIN, authorization: `Bearer ${TOKEN}` }), { status: 500 });
    const response = await handleRequest(authed("/ledger/txs"), env(), zeroDeps(leakingFetch));
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PIN);
    expect(text).toContain("notion request failed");

    const health = await handleRequest(new Request("https://sync.example/health"), env(), zeroDeps());
    const healthText = await health.text();
    expect(health.status).toBe(200);
    expect(healthText).not.toContain(TOKEN);
    expect(healthText).not.toContain(PIN);
    expect(healthText).toContain("tonic-sync-api");
  });
});

describe("routes", () => {
  it("queries a month and returns ledger rows", async () => {
    let filter: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      filter = JSON.parse(String(init?.body)).filter;
      return Response.json({
        results: [
          {
            id: "page-1",
            last_edited_time: "2026-10-26T00:00:00.000Z",
            properties: {
              外部ID: { rich_text: [{ plain_text: "tx_1" }] },
              類型: { select: { name: "收入" } },
              業務體: { select: { name: "塔羅斯" } },
              類別: { select: { name: "設備銷售" } },
              金額: { number: 10 },
              有發票: { checkbox: false },
              備註: { rich_text: [{ plain_text: "" }] },
              項目: { title: [{ plain_text: "設備銷售" }] },
              日期: { date: { start: "2026-10-08" } },
              已刪除: { checkbox: false },
            },
          },
        ],
        has_more: false,
      });
    };
    const response = await handleRequest(authed("/ledger/txs?month=2026-10"), env(), zeroDeps(fetchImpl));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://tonicwang.github.io");
    const body = await response.json();
    expect(filter).toEqual({
      and: [
        { property: "日期", date: { on_or_after: "2026-10-01" } },
        { property: "日期", date: { before: "2026-11-01" } },
      ],
    });
    expect(body).toEqual({
      ok: true,
      txs: [
        {
          id: "tx_1",
          date: "2026-10-08",
          type: "income",
          entity: "taros",
          category: "設備銷售",
          amount: 10,
          hasInvoice: false,
          note: "",
          deleted: false,
          updatedAt: "2026-10-26T00:00:00.000Z",
        },
      ],
    });
  });

  it("rejects a bad month before calling Notion", async () => {
    const response = await handleRequest(authed("/ledger/txs?month=2026-13"), env(), zeroDeps());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "month must be YYYY-MM" });
  });
});
