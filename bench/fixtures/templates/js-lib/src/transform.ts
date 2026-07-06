/**
 * Record transforms: grouping, aggregation, indexing, and pivoting.
 *
 * All functions are pure: they never mutate their inputs, and outputs
 * preserve first-seen ordering of keys (grouping is stable), which makes
 * results deterministic and easy to snapshot in tests.
 */

/** Extracts a string key from a record. */
export type KeyFn<T> = (record: T) => string;

/** Named aggregate functions applied to each group in {@link rollup}. */
export type Aggregations<T> = Record<string, (group: T[]) => unknown>;

/** Result shape of {@link pivot}. */
export interface PivotTable {
  /** Distinct column keys, in first-seen order. */
  columns: string[];
  /** One entry per distinct row key, in first-seen order. */
  rows: PivotRow[];
}

export interface PivotRow {
  /** The row key. */
  key: string;
  /** One cell per column, aligned with {@link PivotTable.columns}. */
  cells: unknown[];
}

/**
 * Group records by a derived string key.
 *
 * Returns a Map from key to the records that produced it. Keys appear in
 * first-seen order and records within a group keep their input order. Any
 * string is a valid key, including the empty string.
 */
export function groupBy<T>(records: ReadonlyArray<T>, key: KeyFn<T>): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const k = key(record);
    let bucket = groups.get(k);
    if (bucket === undefined) {
      bucket = [];
      groups.set(k, bucket);
    }
    bucket.push(record);
  }
  return groups;
}

/**
 * Group records by key, then reduce each group with named aggregations.
 *
 * Returns a Map from group key to an object with one property per
 * aggregation. Group ordering matches {@link groupBy}.
 *
 * ```ts
 * rollup(sales, (s) => s.region, {
 *   orders: (g) => g.length,
 *   revenue: (g) => g.reduce((acc, s) => acc + s.amount, 0),
 * });
 * ```
 */
export function rollup<T>(
  records: ReadonlyArray<T>,
  key: KeyFn<T>,
  aggregations: Aggregations<T>,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const [k, group] of groupBy(records, key)) {
    const row: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(aggregations)) {
      row[name] = fn(group);
    }
    out.set(k, row);
  }
  return out;
}

/**
 * Index records by a key expected to be unique.
 *
 * Returns a Map from key to the single record that produced it. Throws a
 * RangeError when two records share a key, since silently keeping either
 * one hides data errors.
 */
export function indexBy<T>(records: ReadonlyArray<T>, key: KeyFn<T>): Map<string, T> {
  const index = new Map<string, T>();
  for (const record of records) {
    const k = key(record);
    if (index.has(k)) {
      throw new RangeError(`indexBy: duplicate key ${JSON.stringify(k)}`);
    }
    index.set(k, record);
  }
  return index;
}

/**
 * Build a pivot table: rows from `rowKey`, columns from `colKey`, and each
 * cell the result of `value` applied to the records sharing that row/column
 * pair. Cells with no matching records are filled with `fill` (default
 * `null`). Row and column ordering is first-seen order over the input.
 *
 * ```ts
 * pivot(sales, (s) => s.region, (s) => s.quarter, (g) => g.length, 0);
 * ```
 */
export function pivot<T>(
  records: ReadonlyArray<T>,
  rowKey: KeyFn<T>,
  colKey: KeyFn<T>,
  value: (group: T[]) => unknown,
  fill: unknown = null,
): PivotTable {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const c = colKey(record);
    if (!seen.has(c)) {
      seen.add(c);
      columns.push(c);
    }
  }

  const rows: PivotRow[] = [];
  for (const [k, group] of groupBy(records, rowKey)) {
    const byCol = groupBy(group, colKey);
    rows.push({
      key: k,
      cells: columns.map((c) => {
        const cell = byCol.get(c);
        return cell === undefined ? fill : value(cell);
      }),
    });
  }
  return { columns, rows };
}
