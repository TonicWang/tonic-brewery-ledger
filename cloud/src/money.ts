/** 1 minor unit = 0.01 TWD. 22.5 TWD => 2250. Arithmetic stays on integers. */
export const MAX_CENTS = 100_000_000_000;

export function centsToTwd(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function addCents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error("cents must be integers");
    total += value;
  }
  return total;
}

/** Blank sheet cells stay unknown. "0" is a real zero. */
export function twdToCents(value: unknown): number | "blank" | "invalid" {
  if (value === null || value === undefined) return "blank";
  if (typeof value === "number") return numberToCents(value);
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "未知" || trimmed === "-" || trimmed === "—") return "blank";
  let normalized = trimmed;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(trimmed)) normalized = trimmed.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return "invalid";
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return "invalid";
  return cents;
}

export function parseMinorUnits(value: unknown): number | "blank" | "invalid" {
  if (value === null || value === undefined) return "blank";
  if (typeof value === "string" && value.trim() === "") return "blank";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) return "invalid";
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed) || parsed > MAX_CENTS) return "invalid";
    return parsed;
  }
  return "invalid";
}

function numberToCents(value: number): number | "invalid" {
  if (!Number.isFinite(value) || value < 0) return "invalid";
  const rounded = Math.round(value * 100);
  if (!Number.isSafeInteger(rounded) || rounded > MAX_CENTS) return "invalid";
  if (Math.abs(value * 100 - rounded) > 1e-6) return "invalid";
  return rounded;
}
