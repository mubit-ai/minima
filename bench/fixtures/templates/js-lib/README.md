# datakit

A zero-dependency TypeScript utility library for working with tabular and
nested data. Runs on [Bun](https://bun.sh); tests use `bun:test`.

## Modules

| Module              | Contents                                                              |
| ------------------- | --------------------------------------------------------------------- |
| `src/csv.ts`        | RFC 4180-flavoured CSV parser/serializer, header-aware record I/O      |
| `src/transform.ts`  | Record transforms: `groupBy`, `rollup`, `indexBy`, `pivot`             |
| `src/stats.ts`      | Descriptive statistics: `mean`, `variance`, `quantile`, `histogram`, … |
| `src/object.ts`     | Deep object tools: `deepMerge`, `getPath`, `setPath`, `deepDiff`, …    |

Everything is re-exported from `src/index.ts`.

## Design notes

- **No runtime dependencies.** The library uses only ECMAScript built-ins.
- **Deterministic.** No wall-clock reads, no randomness, no I/O.
- **Round-trip safety.** `parseCsv(serializeCsv(rows))` is the identity for
  string data; the serializer quotes exactly the fields the parser needs
  quoted.

## Running the tests

```sh
bun test tests/
```
