import { adaptD1 } from "./d1-adapter";
import { handleApi } from "./handler";

const STATIC_CSP = [
  "default-src 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, { db: env.DB ? adaptD1(env.DB) : undefined });
    }
    if (!env.ASSETS) {
      return Response.json({ ok: false, error: "cloud_unconfigured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const asset = await env.ASSETS.fetch(request);
    return withStaticHeaders(asset);
  },
} satisfies ExportedHandler<Env>;

function withStaticHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", STATIC_CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "microphone=(), geolocation=(), camera=()");
  const type = headers.get("Content-Type") ?? "";
  if (type.includes("text/html")) headers.set("Cache-Control", "no-cache");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
