import type { Database, SqlValue, Statement } from "./db";

interface BoundStatement {
  bind(...values: unknown[]): BoundStatement;
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
}

export function adaptD1(db: { prepare(sql: string): BoundStatement }): Database {
  return {
    prepare(sql: string): Statement {
      const prepared = db.prepare(sql);
      const wrap = (bound: BoundStatement): Statement => ({
        bind(...values: SqlValue[]) {
          return wrap(prepared.bind(...values));
        },
        run: () => bound.run(),
        all: () => bound.all(),
        first: async () => (await bound.first()) ?? null,
      });
      return wrap(prepared);
    },
  };
}
