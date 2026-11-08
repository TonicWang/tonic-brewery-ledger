import { describe, expect, it } from "vitest";
import { parseLedgerDocument } from "../src/legacy";

describe("legacy documents", () => {
  it("reads version 0.1 amounts as TWD major units and preserves ids", () => {
    const parsed = parseLedgerDocument({
      version: "0.1",
      exportedAt: "2026-11-01T00:00:00.000Z",
      txs: [
        {
          id: "tx_example_225",
          date: "2026-11-03",
          type: "expense",
          entity: "yapi",
          category: "自訂舊類別",
          amount: 22.5,
          hasInvoice: true,
          note: "EXAMPLE",
          createdAt: 1_762_131_600_000,
        },
      ],
    });
    expect(parsed.transactions?.invalid).toEqual([]);
    expect(parsed.transactions?.rows[0]).toMatchObject({
      id: "tx_example_225",
      amountCents: 2250,
      category: "自訂舊類別",
      createdAtMs: 1_762_131_600_000,
      note: "EXAMPLE",
    });
    expect(parsed.transactions?.warnings.some((warning) => warning.code === "category_preserved")).toBe(true);
  });

  it("reads a store wrapper without dropping rows when count disagrees", () => {
    const parsed = parseLedgerDocument({
      count: 99,
      transactions: [
        { id: "tx_example_wrap", date: "2026-11-02", type: "income", entity: "啤酒王", category: "其他收入", amount: 1, hasInvoice: false, note: "EXAMPLE" },
      ],
    });
    expect(parsed.warnings.some((warning) => warning.code === "count_mismatch")).toBe(true);
    expect(parsed.transactions?.rows).toHaveLength(1);
    expect(parsed.transactions?.rows[0].entity).toBe("beerwang");
    expect(parsed.transactions?.rows[0].amountCents).toBe(100);
  });

  it("keeps unknown obligation fields unknown and does not turn blanks into zero", () => {
    const parsed = parseLedgerDocument({
      固定支出: [
        {
          業務體: "雅啤精釀",
          項目: "房租",
          週期: "",
          本次帳單: "1000.50",
          本次實付: "",
          到期日: "",
          未來月額: "1000.50",
          備註: "EXAMPLE 到期未知",
          啟用: "是",
        },
        {
          業務體: "塔羅斯Talos",
          項目: "電費",
          本次帳單: "0",
          本次實付: "0",
          到期日: "未知",
          未來月額: "",
          啟用: "",
          備註: "EXAMPLE",
        },
      ],
    });
    expect(parsed.obligations?.invalid).toEqual([]);
    const [rent, power] = parsed.obligations?.rows ?? [];
    expect(rent).toMatchObject({
      entity: "yapi",
      item: "房租",
      cycle: null,
      billedCents: 100050,
      paidCents: null,
      dueDate: null,
      futureMonthlyCents: 100050,
      enabled: true,
    });
    expect(power).toMatchObject({
      entity: "taros",
      billedCents: 0,
      paidCents: 0,
      dueDate: null,
      futureMonthlyCents: null,
      enabled: null,
    });
  });
});
