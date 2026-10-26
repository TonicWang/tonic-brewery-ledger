import { timingSafeEqual } from "node:crypto";

export const DEFAULT_ORIGIN = "https://tonicwang.github.io";

export function parseAllowedOrigins(raw: string | undefined): string[] {
  const value = raw?.trim() ? raw : DEFAULT_ORIGIN;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function corsHeaders(origin: string): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-App-Pin");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

/**
 * Compare a header to APP_PIN without leaking the secret through timing or length.
 * Both sides are hashed to a fixed size first.
 */
export async function secretEquals(provided: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(Buffer.from(leftHash), Buffer.from(rightHash));
}

export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}
