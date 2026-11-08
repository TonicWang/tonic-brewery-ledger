import { expect } from "vitest";
import { handleApi, type AppEnv } from "../src/handler";
import type { Database } from "../src/db";

export const PASSWORD = "example-owner-passphrase";
export const ASSISTANT = "example-assistant-token-0123456789abcd";
export const NOW = () => new Date("2026-11-08T02:00:00.000Z");

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    OWNER_PASSWORD: PASSWORD,
    ASSISTANT_TOKEN: ASSISTANT,
    ALLOWED_ORIGINS: "",
    APP_MODE: "local-test",
    WRITE_RATE_LIMIT: "1000",
    READ_RATE_LIMIT: "1000",
    IP_RATE_LIMIT: "1000",
    LOGIN_LIMIT: "5",
    ...overrides,
  };
}

export async function readerCookie(db: Database, env: AppEnv = testEnv()): Promise<string> {
  const response = await handleApi(
    new Request("https://blue.test/api/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://blue.test" },
      body: JSON.stringify({ password: env.OWNER_PASSWORD }),
    }),
    env,
    { db, now: NOW },
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("Set-Cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie.toLowerCase()).not.toContain(String(env.OWNER_PASSWORD).toLowerCase());
  return cookie.split(";")[0];
}

export function asReader(path: string, cookie: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  headers.set("Origin", "https://blue.test");
  return new Request(`https://blue.test${path}`, { ...init, headers });
}

export function asAssistant(path: string, init: RequestInit = {}, key?: string): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ASSISTANT}`);
  if (key) headers.set("Idempotency-Key", key);
  return new Request(`https://blue.test${path}`, { ...init, headers });
}

export async function ownerCookie(db: Database): Promise<string> {
  const response = await handleApi(
    new Request("https://blue.test/api/v1/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://blue.test",
        "X-Tonic-Owner-Intent": "1",
      },
      body: JSON.stringify({ password: PASSWORD, role: "owner" }),
    }),
    testEnv(),
    { db, now: NOW },
  );
  expect(response.status).toBe(200);
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0];
}
