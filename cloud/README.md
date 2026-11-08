# Tonic Blue

Cloudflare Worker + D1 ledger and a read-only Traditional Chinese phone page. It does not replace the site at the repository root.

Operator steps, secrets, and the cutover rules are in [../docs/tonic-blue.md](../docs/tonic-blue.md). This directory is not deployed by this change. `database_id` in `wrangler.jsonc` is a placeholder.

```bash
npm test
npm run typecheck
```

Synthetic UI data is `public/fixture.example.json`, labeled TEST / EXAMPLE. Do not commit a real export.
