export interface Classified<T> {
  identical: T[];
  conflicts: Array<{ id: string; existing: T; incoming: T }>;
  onlyIncoming: T[];
  onlyExisting: T[];
}

export function collapseById<T extends { id: string }>(
  rows: T[],
  signature: (row: T) => string,
): { rows: T[]; conflicts: Array<{ id: string; rows: T[] }> } {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.id) ?? [];
    list.push(row);
    groups.set(row.id, list);
  }
  const kept: T[] = [];
  const conflicts: Array<{ id: string; rows: T[] }> = [];
  for (const [id, list] of groups) {
    const signatures = new Set(list.map(signature));
    if (signatures.size === 1) kept.push(list[0]);
    else conflicts.push({ id, rows: list });
  }
  return { rows: kept, conflicts };
}

export function classifyById<T extends { id: string }>(
  existing: T[],
  incoming: T[],
  signature: (row: T) => string,
): Classified<T> {
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const incomingIds = new Set<string>();
  const identical: T[] = [];
  const conflicts: Array<{ id: string; existing: T; incoming: T }> = [];
  const onlyIncoming: T[] = [];
  for (const row of incoming) {
    incomingIds.add(row.id);
    const previous = existingById.get(row.id);
    if (!previous) {
      onlyIncoming.push(row);
      continue;
    }
    if (signature(previous) === signature(row)) identical.push(row);
    else conflicts.push({ id: row.id, existing: previous, incoming: row });
  }
  const onlyExisting = existing.filter((row) => !incomingIds.has(row.id));
  return { identical, conflicts, onlyIncoming, onlyExisting };
}
