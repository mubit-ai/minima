/**
 * datakit — zero-dependency data utilities.
 *
 * Re-exports the public API of every module so consumers can write
 * `import { parseCsv, groupBy, quantile, deepMerge } from "datakit"`.
 */

export {
  parseCsv,
  serializeCsv,
  parseRecords,
  serializeRecords,
  type CsvParseOptions,
  type CsvSerializeOptions,
  type CsvRecordSerializeOptions,
} from "./csv.ts";

export {
  groupBy,
  rollup,
  indexBy,
  pivot,
  type KeyFn,
  type Aggregations,
  type PivotTable,
  type PivotRow,
} from "./transform.ts";

export {
  sum,
  mean,
  variance,
  stdev,
  quantile,
  median,
  pearson,
  histogram,
  type VarianceOptions,
  type HistogramBin,
  type HistogramOptions,
} from "./stats.ts";

export {
  isPlainObject,
  deepClone,
  deepEqual,
  deepMerge,
  getPath,
  setPath,
  flattenPaths,
  deepDiff,
  type ArrayStrategy,
  type MergeOptions,
  type DiffEntry,
} from "./object.ts";
