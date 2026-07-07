# taskman

A small, dependency-free task/todo manager with a JSON file backend.

```sh
python3 -m taskman --file tasks.json add "Buy milk" -p high --tags home,errand --due 2026-07-10
python3 -m taskman --file tasks.json list --tag home --sort due
python3 -m taskman --file tasks.json agenda
python3 -m taskman --file tasks.json done 1
python3 -m taskman --file tasks.json report
```

## Design notes

- **Deterministic time.** Every date comparison flows through an explicit
  `today` value, resolvable from the `--today` flag or the `TASKMAN_TODAY`
  environment variable (see `taskman/dates.py`). Tests never touch the
  real clock.
- **Schema-versioned storage.** The JSON file carries a `schema` marker;
  older files (v1/v2) are migrated in memory on load
  (`taskman/migrations.py`) and rewritten at the current version on save.
- **Pure query layer.** Filtering, search, agenda buckets and sorting in
  `taskman/query.py` are side-effect-free functions over `Task` lists.
- **Reports.** `taskman/report.py` renders the list table and the
  `report` command's summary/priority/tag sections.

## Development

Run the test suite from the repository root:

```sh
python3 -m pytest -q
```

No third-party packages are required beyond `pytest`.
