import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = `${import.meta.dirname}/../public`;

describe("phone client does not persist ledger records", () => {
  it("keeps transaction storage APIs out of the page scripts", () => {
    const forbidden = ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "openDatabase", "caches.open"];
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".js") && !name.endsWith(".html")) continue;
      const source = readFileSync(`${root}/${name}`, "utf8");
      if (name === "sw.js") {
        expect(source).toContain('pathname.includes("/api/")');
        expect(source).not.toContain("transactions");
        continue;
      }
      for (const token of forbidden) expect(source, name).not.toContain(token);
    }
  });
});
