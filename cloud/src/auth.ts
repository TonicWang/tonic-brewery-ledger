import { timingSafeEqual } from "node:crypto";

export type Role = "reader" | "assistant" | "owner";
export type Scope = "read" | "export" | "write" | "obligations" | "migrate-preview" | "migrate-apply" | "restore" | "audit";

const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  reader: ["read", "export"],
  assistant: ["read", "write", "obligations", "migrate-preview"],
  owner: ["read", "export", "write", "obligations", "migrate-preview", "migrate-apply", "restore", "audit"],
};

export function scopesFor(role: Role): readonly Scope[] {
  return ROLE_SCOPES[role];
}

export function ownerPasswordConfigured(value: string | undefined): boolean {
  if (!value || value.length < 12) return false;
  if (/^\d{1,8}$/.test(value)) return false;
  return true;
}

export function assistantTokenConfigured(value: string | undefined): boolean {
  if (!value || value.length < 32) return false;
  if (/^\d+$/.test(value)) return false;
  return true;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function secretEquals(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const match = timingSafeEqual(Buffer.from(left), Buffer.from(right));
  return expected.length > 0 && match;
}

export function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function derivedId(prefix: "tx" | "ob", actor: string, idempotencyKey: string): Promise<string> {
  const digest = await sha256Hex(`${prefix}:${actor}:${idempotencyKey}`);
  return `${prefix}_${digest.slice(0, 24)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
