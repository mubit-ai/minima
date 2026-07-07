# katas

A dozen self-contained micro-exercises across three languages. Each kata is a
single module exposing one documented function that currently raises/throws
`NotImplementedError` — your job is to implement it so its test suite passes.

Layout:

- `py/` — Python katas (stdlib only). Run a kata's tests with
  `python3 -m pytest -q tests/py/test_<kata>*.py`.
- `ts/` — TypeScript katas. Run with `bun test tests/ts/<kata>`.
- `js/` — JavaScript katas. Run with `bun test tests/js/<kata>`.

Each kata's full contract lives in the doc comment of its stub function.
Suites are independent: implementing one kata never affects another.
