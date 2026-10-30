import { describe, expect, it } from "vitest";
import {
  codeBlocksToJson,
  createRateGate,
  crmRecordToProperties,
  ledgerQueryFilter,
  ledgerTxToProperties,
  listLedger,
  notionPageToCrmRecord,
  notionPageToLedgerTx,
  recordToCodeBlocks,
  upsertCrmRecord,
  upsertLedgerTx,
  type CrmRecord,
  type LedgerTx,
  type NotionDeps,
  type NotionPage,
} from "../src/notion";

const CO2 = "耗材-CO\u2082";

const sampleTx = (): LedgerTx => ({
  id: "tx_1",
  date: "2026-10-03",
  type: "expense",
  entity: "beerwang",
  category: CO2,
  amount: 1200,
  hasInvoice: true,
  note: "鋼瓶",
  deleted: false,
  createdAt: 1,
});

function textOf(value: { rich_text?: Array<{ text: { content: string } }>; title?: Array<{ text: { content: string } }> }): string {
  const items = value.title ?? value.rich_text ?? [];
  return items.map((item) => item.text.content).join("");
}

function asReadPage(id: string, properties: Record<string, any>, lastEdited: string): NotionPage {
  const read: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value.title) read[key] = { type: "title", title: value.title.map((item: { text: { content: string } }) => ({ plain_text: item.text.content })) };
    else if (value.rich_text) {
      read[key] = { type: "rich_text", rich_text: value.rich_text.map((item: { text: { content: string } }) => ({ plain_text: item.text.content })) };
    } else if ("select" in value) read[key] = { type: "select", select: value.select };
    else if ("multi_select" in value) read[key] = { type: "multi_select", multi_select: value.multi_select };
    else if ("number" in value) read[key] = { type: "number", number: value.number };
    else if ("checkbox" in value) read[key] = { type: "checkbox", checkbox: value.checkbox };
    else if ("date" in value) read[key] = { type: "date", date: value.date };
  }
  return { id, last_edited_time: lastEdited, properties: read };
}

describe("ledger mapping", () => {
  it("round-trips a transaction and keeps the subscript category", async () => {
    const tx = sampleTx();
    const properties = ledgerTxToProperties(tx);
    expect(properties["類別"]).toEqual({ select: { name: CO2 } });
    expect(JSON.stringify(properties)).not.toContain("耗材-CO2");
    expect(properties["業務體"]).toEqual({ select: { name: "啤酒王" } });
    expect(properties["類型"]).toEqual({ select: { name: "支出" } });
    expect(properties["來源"]).toEqual({ select: { name: "帳本App" } });
    expect(properties["有發票"]).toEqual({ checkbox: true });
    expect(textOf(properties["外部ID"] as { rich_text: Array<{ text: { content: string } }> })).toBe("tx_1");
    expect(textOf(properties["項目"] as { title: Array<{ text: { content: string } }> })).toBe("鋼瓶");

    const page = asReadPage("page-1", properties, "2026-10-26T03:04:05.000Z");
    const deps: NotionDeps = {
      token: "test-token",
      fetch: async () => new Response("unexpected", { status: 500 }),
      sleep: async () => undefined,
      gate: zeroGate(),
    };
    expect(await notionPageToLedgerTx(deps, page)).toEqual({
      id: "tx_1",
      date: "2026-10-03",
      type: "expense",
      entity: "beerwang",
      category: CO2,
      amount: 1200,
      hasInvoice: true,
      note: "鋼瓶",
      deleted: false,
      updatedAt: "2026-10-26T03:04:05.000Z",
    });
  });

  it("uses the category as the title when the note is empty", () => {
    const properties = ledgerTxToProperties({ ...sampleTx(), note: "" });
    expect(textOf(properties["項目"] as { title: Array<{ text: { content: string } }> })).toBe(CO2);
  });

  it("builds a month-only filter so rows without an external id are included", () => {
    expect(ledgerQueryFilter("2026-10")).toEqual({
      and: [
        { property: "日期", date: { on_or_after: "2026-10-01" } },
        { property: "日期", date: { before: "2026-11-01" } },
      ],
    });
  });
});

describe("crm mapping", () => {
  const record = (): CrmRecord => ({
    inquiryId: "inq-1",
    customerName: "王先生",
    phone: "0912000111",
    lineId: "wang-line",
    productType: "設備",
    quantity: 2,
    quotePrice: 504000,
    followUpDate: "2026-11-02",
    lastContactDate: "2026-10-20",
    owner: "啤酒王",
    notes: "急件",
    status: "quoted",
    history: [{ at: "2026-10-20", action: "建立" }],
    channel: "line",
  });

  it("round-trips the CRM record, including history, from the page body", () => {
    const input = record();
    const properties = crmRecordToProperties(input);
    expect(properties["來源"]).toEqual({ multi_select: [{ name: "塔羅斯CRM" }] });
    expect(properties["品牌"]).toEqual({ select: { name: "塔羅斯" } });
    expect(properties["階段"]).toEqual({ select: { name: "報價" } });
    expect(properties["狀態"]).toEqual({ select: { name: "等客戶" } });
    expect(textOf(properties["項目"] as { title: Array<{ text: { content: string } }> })).toBe("王先生 設備");
    expect(textOf(properties["聯絡方式"] as { rich_text: Array<{ text: { content: string } }> })).toBe("0912000111 / wang-line");
    expect(textOf(properties["承諾內容／下一步"] as { rich_text: Array<{ text: { content: string } }> })).toBe("設備 × 2");

    const blocks = recordToCodeBlocks(input).map((block) => ({
      type: "code",
      code: {
        language: "json",
        rich_text: block.code.rich_text.map((item) => ({ plain_text: item.text.content })),
      },
    }));
    const body = codeBlocksToJson(blocks);
    const page = asReadPage("page-crm", properties, "2026-10-26T08:00:00.000Z");
    const read = notionPageToCrmRecord(page, body);
    expect(read?.history).toEqual(input.history);
    expect(read?.channel).toBe("line");
    expect(read?.quantity).toBe(2);
    expect(read?.status).toBe("quoted");
    expect(read?.owner).toBe("啤酒王");
    expect(read?.updatedAt).toBe("2026-10-26T08:00:00.000Z");
    expect(read?.inquiryId).toBe("inq-1");
  });

  it("maps each status and keeps 階段 when a row is dead", () => {
    expect(crmRecordToProperties({ inquiryId: "a", status: "pending_quote" })["階段"]).toEqual({ select: { name: "詢價" } });
    expect(crmRecordToProperties({ inquiryId: "a", status: "pending_quote" })["狀態"]).toEqual({ select: { name: "待處理" } });
    expect(crmRecordToProperties({ inquiryId: "a", status: "negotiating" })["狀態"]).toEqual({ select: { name: "待確認" } });
    expect(crmRecordToProperties({ inquiryId: "a", status: "signed" })["階段"]).toEqual({ select: { name: "成交" } });
    expect(crmRecordToProperties({ inquiryId: "a", status: "signed" })["狀態"]).toEqual({ select: { name: "已關閉" } });
    const dead = crmRecordToProperties({ inquiryId: "a", status: "dead" });
    expect(dead["狀態"]).toEqual({ select: { name: "已關閉" } });
    expect(dead["階段"]).toBeUndefined();
    const kept = crmRecordToProperties({ inquiryId: "a", status: "dead", stage: "詢價" });
    expect(kept["階段"]).toEqual({ select: { name: "詢價" } });
  });

  it("lets a Notion column edit win while history stays in the body", () => {
    const input = record();
    const properties = crmRecordToProperties(input);
    (properties["客戶"] as { rich_text: Array<{ text: { content: string } }> }).rich_text = [
      { text: { content: "李先生" } },
    ];
    const page = asReadPage("page-crm", properties, "2026-10-26T09:00:00.000Z");
    const read = notionPageToCrmRecord(page, input);
    expect(read?.customerName).toBe("李先生");
    expect(read?.history).toEqual(input.history);
    expect(read?.status).toBe("quoted");
  });

  it("rejoins rich text that was split at 2000 characters", () => {
    const history = [{ note: "備".repeat(2500) }];
    const blocks = recordToCodeBlocks({ inquiryId: "long", history });
    expect(blocks[0]?.code.rich_text.length).toBeGreaterThan(1);
    const readBlocks = blocks.map((block) => ({
      type: "code",
      code: {
        language: "json",
        rich_text: block.code.rich_text.map((item) => ({ plain_text: item.text.content })),
      },
    }));
    expect(codeBlocksToJson(readBlocks)).toEqual({ inquiryId: "long", history });
  });
});

function zeroGate() {
  return createRateGate(0, async () => undefined, () => 0);
}

describe("notion writes", () => {
  it("assigns and persists an external id for a manually created ledger row", async () => {
    const original = asReadPage(
      "123e4567-e89b-12d3-a456-426614174000",
      ledgerTxToProperties({ ...sampleTx(), id: "" }),
      "2026-10-26T00:00:00.000Z",
    );
    const calls: Array<{ method: string; url: string; body: Record<string, any> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, url, body });
      if (url.endsWith("/query")) return Response.json({ results: [original], has_more: false });
      if (method === "PATCH" && url.endsWith(`/pages/${original.id}`)) {
        return Response.json({
          ...original,
          last_edited_time: "2026-10-26T00:01:00.000Z",
          properties: { ...original.properties, 外部ID: { type: "rich_text", rich_text: [{ plain_text: "notion_123e4567e89b12d3a456426614174000" }] } },
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const deps: NotionDeps = { token: "test-token", fetch: fetchImpl, sleep: async () => undefined, gate: zeroGate() };

    const txs = await listLedger(deps, "ledger-db", "2026-10");

    expect(txs).toHaveLength(1);
    expect(txs[0]?.id).toBe("notion_123e4567e89b12d3a456426614174000");
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body.properties["外部ID"].rich_text[0].text.content).toBe(
      "notion_123e4567e89b12d3a456426614174000",
    );
  });

  it("skips an invalid ledger type without assigning an external id", async () => {
    const page = asReadPage("page-invalid", ledgerTxToProperties({ ...sampleTx(), id: "" }), "2026-10-26T00:00:00.000Z");
    page.properties["類型"] = { type: "select", select: { name: "其他" } };
    let patches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/query")) return Response.json({ results: [page], has_more: false });
      if ((init?.method ?? "GET") === "PATCH") patches += 1;
      return new Response("unexpected", { status: 500 });
    };
    const deps: NotionDeps = { token: "test-token", fetch: fetchImpl, sleep: async () => undefined, gate: zeroGate() };

    expect(await listLedger(deps, "ledger-db", "2026-10")).toEqual([]);
    expect(patches).toBe(0);
  });

  it("updates an existing page instead of creating a second one", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const pages: Array<{ id: string; properties: Record<string, unknown>; last_edited_time: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/query")) {
        const externalId = body.filter.rich_text.equals as string;
        const found = pages.filter((page) => {
          const items = (page.properties["外部ID"] as { rich_text?: Array<{ plain_text: string }> }).rich_text ?? [];
          return items.map((item) => item.plain_text).join("") === externalId;
        });
        return Response.json({ results: found, has_more: false });
      }
      if (url.endsWith("/v1/pages") && method === "POST") {
        const page = asReadPage(`page-${pages.length + 1}`, body.properties, "2026-10-26T00:00:00.000Z");
        pages.push(page as { id: string; properties: Record<string, unknown>; last_edited_time: string });
        return Response.json(page);
      }
      const match = url.match(/\/pages\/([^/?]+)$/);
      if (match && method === "PATCH") {
        const page = pages.find((item) => item.id === match[1]);
        if (!page) return new Response("missing", { status: 404 });
        const patched = asReadPage(page.id, body.properties, "2026-10-26T00:01:00.000Z");
        page.properties = patched.properties;
        page.last_edited_time = patched.last_edited_time ?? page.last_edited_time;
        return Response.json(page);
      }
      return new Response("unexpected", { status: 500 });
    };
    const deps: NotionDeps = { token: "test-token", fetch: fetchImpl, sleep: async () => undefined, gate: zeroGate() };
    const tx = sampleTx();
    await upsertLedgerTx(deps, "ledger-db", tx);
    await upsertLedgerTx(deps, "ledger-db", { ...tx, amount: 1300 });
    const creates = calls.filter((call) => call.method === "POST" && call.url.endsWith("/v1/pages"));
    const patches = calls.filter((call) => call.method === "PATCH" && call.url.includes("/pages/page-1"));
    expect(creates).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(pages).toHaveLength(1);
  });

  it("retries a 429 and then creates once", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      const url = String(input);
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
      if (url.endsWith("/query")) return Response.json({ results: [], has_more: false });
      const body = JSON.parse(String(init?.body));
      return Response.json(asReadPage("page-new", body.properties, "2026-10-26T00:00:00.000Z"));
    };
    const deps: NotionDeps = {
      token: "test-token",
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      gate: zeroGate(),
    };
    const saved = await upsertLedgerTx(deps, "ledger-db", sampleTx());
    expect(saved.id).toBe("tx_1");
    expect(calls).toBe(3);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("patches a CRM page on the second upsert", async () => {
    const calls: string[] = [];
    let page: NotionPage | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.replace("https://api.notion.com/v1", "")}`);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/query")) {
        return Response.json({ results: page ? [page] : [], has_more: false });
      }
      if (method === "POST" && url.endsWith("/pages")) {
        page = asReadPage("crm-page", body.properties, "2026-10-26T00:00:00.000Z");
        return Response.json(page);
      }
      if (method === "PATCH" && url.endsWith("/pages/crm-page")) {
        page = asReadPage("crm-page", body.properties, "2026-10-26T00:02:00.000Z");
        return Response.json(page);
      }
      if (method === "GET" && url.includes("/children")) return Response.json({ results: [], has_more: false });
      if (method === "PATCH" && url.includes("/children")) return Response.json({ results: [] });
      return new Response("unexpected", { status: 500 });
    };
    const deps: NotionDeps = { token: "test-token", fetch: fetchImpl, sleep: async () => undefined, gate: zeroGate() };
    const record: CrmRecord = { inquiryId: "inq-9", customerName: "王先生", productType: "設備", status: "pending_quote", history: [] };
    await upsertCrmRecord(deps, "crm-db", record);
    await upsertCrmRecord(deps, "crm-db", { ...record, status: "signed" });
    expect(calls.filter((call) => call.startsWith("POST /pages"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("PATCH /pages/crm-page"))).toBe(true);
  });

  it("spaces Notion calls at 3 per second or slower", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const gate = createRateGate(
      334,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      () => now,
    );
    await gate.wait();
    await gate.wait();
    await gate.wait();
    expect(sleeps).toEqual([334, 334]);
  });
});
