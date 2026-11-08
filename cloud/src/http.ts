export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, details?: Record<string, unknown>) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(body: unknown, status: number, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  return new Response(JSON.stringify(body), { status, headers });
}

export function resolveCors(request: Request, allowedRaw: string | undefined): { ok: boolean; headers: Headers } {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (!origin) return { ok: true, headers };
  const allowed = (allowedRaw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const sameOrigin = origin === new URL(request.url).origin;
  if (!sameOrigin && !allowed.includes(origin)) return { ok: false, headers };
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Tonic-Owner-Intent");
  headers.set("Access-Control-Max-Age", "600");
  return { ok: true, headers };
}

export function scrub(text: string, secrets: Array<string | undefined>): string {
  let output = text;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[redacted]");
  }
  return output.slice(0, 500);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean, maxAge: number): string {
  const parts = [`tonic_blue_session=${token}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function readJson(request: Request, maxChars = 1_500_000): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxChars) throw new HttpError(413, "payload_too_large");
  if (!text) throw new HttpError(400, "invalid_json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
