# Publishing checklist — Minima + `minima-harness`

The wheel ships three packages together (`pyproject.toml` → `tool.hatch.build.targets.wheel`):
`src/minima` (recommender API), `src/minima_harness` (TUI agent), `client_sdk/minima_client`
(HTTP SDK). Entry points: `minima-harness`, `minima-seed`, `minima-calibration-report`.

> **License is `Proprietary`.** Decide the distribution target *first* — public PyPI is almost
> certainly **not** intended. Default assumption: a **private index** (or internal artifact
> store) and/or a tagged Git release. Steps below are index-agnostic; the "Public PyPI only"
> items are called out and should stay skipped unless the license changes.

## 1. Decide & confirm
- [ ] Distribution target chosen: private index / internal store / Git tag (NOT public PyPI while Proprietary).
- [ ] Release scope agreed (what's in `harness_v1` going out: config command, overlay reworks, footer fixes, Phase 0–3 work).

## 2. Version & changelog
- [ ] Bump `version` in `pyproject.toml` (currently `0.3.0`) per semver.
- [ ] Add a `CHANGELOG.md` entry (config command, keyring storage, UI/overlay redesign, footer key display).
- [ ] Confirm `requires-python = ">=3.11"` still holds for all new code.

## 3. Repo hygiene & secrets
- [ ] No secrets committed: `git grep -nE 'sk-(ant|proj)|AIza|MUBIT_API_KEY=.+' -- . ':!*.example'` returns nothing.
- [ ] `.env`, `.env.harness` are git-ignored; only `.env.example` / stub `.env.harness` (empty keys) are tracked.
- [ ] `~/.minima-harness/config.env` is never created in-repo (it's per-user); keyring is the default backend.
- [ ] Working tree clean; release branch merged/tagged off `main`.

## 4. Packaging metadata
- [ ] `pyproject.toml`: `description`, `readme`, `authors`, and add `[project.urls]` (Homepage/Docs/Repository).
- [ ] Optional-dependency extras correct: `harness`, `tui` (now includes `keyring>=24`), `seed`, `reasoner-anthropic`, `reasoner-gemini`, `dev`.
- [ ] Wheel `packages` list includes all three dirs; non-Python data (e.g. `capability_priors.json`, any JSON catalogs) ships — verify in step 6.
- [ ] Entry points resolve: `minima-harness`, `minima-seed`, `minima-calibration-report`.

## 5. Quality gates (must pass)
- [ ] `uv run pytest -m "not live and not eval" -q` — full non-live suite green.
- [ ] `make lint` — `ruff check src client_sdk tests` + `mypy src/minima` clean.
- [ ] (Optional) live/eval suites run intentionally where infra is available.

## 6. Build & verify the artifact
- [ ] `uv build` → produces `dist/*.whl` + `dist/*.tar.gz`.
- [ ] `uvx twine check dist/*` passes (metadata/readme render).
- [ ] Inspect wheel contents: `python -m zipfile -l dist/*.whl` includes `minima/`, `minima_harness/`, `minima_client/`, and required data files.
- [ ] Clean-room smoke test (fresh venv, install from the built wheel with `[tui]`):
  - [ ] `minima-harness --help` and `minima-seed --help` run.
  - [ ] `minima-harness config list` shows both sections (all MISSING) without error.
  - [ ] `minima-harness config set ANTHROPIC_API_KEY <dummy>` → `config list` masks it; `config path` prints the location.
  - [ ] `minima-harness config doctor` reports presence + Minima `/v1/health` reachability (no secret values printed).
  - [ ] Demo mode runs offline: `python examples/harness_warmup.py`.
  - [ ] TUI launches and quits cleanly; `/config` overlay opens.

## 7. Docs
- [ ] `README.md` quickstart current; `docs/harness.md` documents `minima-harness config` (done) + keyring/0600 fallback + precedence.
- [ ] First-run path documented: where `MUBIT_API_KEY` + provider keys go (config command → keyring/`~/.minima-harness/config.env`).
- [ ] `docs/configuration.md` lists any new env vars; links not broken.

## 8. Release
- [ ] Tag: `git tag v<version> && git push --tags`.
- [ ] Publish to the chosen target:
  - [ ] Private index: `uvx twine upload --repository <name> dist/*` (or the index's documented flow).
  - [ ] Public PyPI **only if license changed**: TestPyPI dry-run first, then PyPI.
- [ ] Create the release notes (GitHub release or internal) from the changelog.

## 9. Post-publish verification
- [ ] Install the *published* artifact in a clean venv (not the local wheel) and re-run the step-6 smoke tests.
- [ ] Confirm `minima-harness config` works against the hosted Minima (`MINIMA_URL=https://api.minima.sh`) end to end.
- [ ] Announce / update any install docs with the new version + the config-first setup flow.
