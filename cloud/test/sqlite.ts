import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Database, SqlValue, Statement } from "../src/db";

export function createTestDb(): Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(`${import.meta.dirname}/../migrations/0001_init.sql`, "utf8"));
  return {
    prepare(sql: string): Statement {
      const create = (params: SqlValue[]): Statement => ({
        bind(...values: SqlValue[]) {
          return create(values);
        },
        async run() {
          const info = sqlite.prepare(sql).run(...(params as (string | number | null)[]));
          return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
        async all<T>() {
          return { results: sqlite.prepare(sql).all(...(params as (string | number | null)[])) as T[] };
        },
        async first<T>() {
          const row = sqlite.prepare(sql).get(...(params as (string | number | null)[])) as T | undefined;
          return row ?? null;
        },
      });
      return create([]);
    },
  };
}
