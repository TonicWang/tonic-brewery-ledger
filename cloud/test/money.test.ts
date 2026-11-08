import { describe, expect, it } from "vitest";
import { addCents, centsToTwd, parseMinorUnits, twdToCents } from "../src/money";

describe("integer minor units", () => {
  it("converts fractional TWD without binary drift, including 22.5", () => {
    expect(twdToCents("22.5")).toBe(2250);
    expect(twdToCents(22.5)).toBe(2250);
    expect(twdToCents("22.50")).toBe(2250);
    expect(twdToCents("0.50")).toBe(50);
    expect(twdToCents("1,200.50")).toBe(120050);
    expect(centsToTwd(addCents([2250, 50]))).toBe("23.00");
    expect(centsToTwd(2250 - 50)).toBe("22.00");
  });

  it("rejects values that are not exact hundredths and keeps blanks unknown", () => {
    expect(twdToCents("22.555")).toBe("invalid");
    expect(twdToCents(1.005)).toBe("invalid");
    expect(twdToCents("")).toBe("blank");
    expect(twdToCents(null)).toBe("blank");
    expect(twdToCents("未知")).toBe("blank");
    expect(twdToCents("0")).toBe(0);
    expect(parseMinorUnits(22.5)).toBe("invalid");
    expect(parseMinorUnits(2250)).toBe(2250);
    expect(parseMinorUnits(-1)).toBe("invalid");
  });
});
