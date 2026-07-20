# Publishing checklist — `minima-cli` (PyPI)

The wheel ships two packages together (`pyproject.toml` → `tool.hatch.build.targets.wheel`):
`src/minima` (recommender API) and `client_sdk/minima_client` (HTTP SDK). Entry points:
`minima-seed`, `minima-calibration-report`. The `minima` CLI/TUI is NOT part of this wheel —
it ships as a TypeScript binary via Homebrew (`brew tap mubit-ai/minima`); the Python harness
was removed in v0.7.0.

> **License is `FSL-1.1-Apache-2.0`** (source-available, non-compete; auto-converts to Apache-2.0
> after 2 years). The repo is public, so **public PyPI is fine** — PyPI permits non-OSI licenses.
> Note FSL is *not* OSI-"open source", so don't add `License :: OSI Approved` classifiers.

## 1. Decide & confirm
- [x] License: `FSL-1.1-Apache-2.0` (see `LICENSE`); repo + package public.
- [ ] Release scope agreed (config command + prompt/routing/predictability phases + copy-paste/mouse fix + overlay reworks + banner).

## 2. Version & changelog
- [ ] Bump `version` in `pyproject.toml` (currently `0.3.0`) per semver.
- [ ] Add a `CHANGELOG.md` entry for the release.
- [ ] Confirm `requires-python = ">=3.11"` still holds for all new code.

## 3. Repo hygiene & secrets
- [ ] No secrets committed: `git grep -nE 'sk-(ant|proj)|AIza|MUBIT_API_KEY=.+' -- . ':!*.example'` returns nothing.
- [ ] `.env`, `.env.harness` are git-ignored; only `.env.example` / stub `.env.harness` (empty keys) are tracked.
- [ ] Working tree clean; release branch merged/tagged off `main`.

## 4. Packaging metadata
- [ ] `pyproject.toml`: `description`, `readme`, `authors`, and add `[project.urls]` (Homepage/Docs/Repository).
- [ ] Optional-dependency extras correct: `server`, `seed`, `reasoner-anthropic`, `reasoner-gemini`, `dev`.
- [ ] Wheel `packages` list includes both dirs; non-Python data (e.g. `capability_priors.json`, any JSON catalogs) ships — verify in step 6.
- [ ] Entry points resolve: `minima-seed`, `minima-calibration-report`.

## 5. Quality gates (must pass)
- [ ] `uv run pytest -m "not live and not eval" -q` — full non-live suite green.
- [ ] `make lint` — `ruff check src client_sdk tests` + `mypy src/minima` clean.
- [ ] (Optional) live/eval suites run intentionally where infra is available.

## 6. Build & verify the artifact
- [ ] `uv build` → produces `dist/*.whl` + `dist/*.tar.gz`.
- [ ] `uvx twine check dist/*` passes (metadata/readme render).
- [ ] Inspect wheel contents: `python -m zipfile -l dist/*.whl` includes `minima/`, `minima_client/`, and required data files.
- [ ] Clean-room smoke test (fresh venv, install from the built wheel):
  - [ ] `minima-seed --help` and `minima-calibration-report --help` run.
  - [ ] `python -c "from minima_client import MinimaClient"` works.
  - [ ] With `[server]`: `uvicorn minima.main:app` starts and `/v1/health` responds.

## 7. Docs
- [ ] `README.md` quickstart current (CLI install = Homebrew; pip = SDK + server tooling).
- [ ] `docs/configuration.md` lists any new env vars; links not broken.

## 8. Release
- [ ] Tag: `git tag v<version> && git push --tags`.
- [ ] Publish to the chosen target:
  - [ ] Private index: `uvx twine upload --repository <name> dist/*` (or the index's documented flow).
  - [ ] Public PyPI **only if license changed**: TestPyPI dry-run first, then PyPI.
- [ ] Create the release notes (GitHub release or internal) from the changelog.

## 9. Post-publish verification
- [ ] Install the *published* artifact in a clean venv (not the local wheel) and re-run the step-6 smoke tests.
- [ ] Confirm the SDK works against the hosted Minima (`MINIMA_URL=https://api.minima.sh`) end to end.
- [ ] `api.minima.sh/v1/health` reports the released version (prod deploy landed).
- [ ] The Homebrew tap serves the released version (the release workflow pushes and
      verifies this, but check when in doubt — 0.11.0 and 0.12.0 both once sat in
      unmerged formula PRs while brew kept serving 0.10.0):
      `curl -fsSL https://raw.githubusercontent.com/mubit-ai/homebrew-minima/main/Formula/minima.rb | grep version`
- [ ] Announce / update any install docs with the new version + the config-first setup flow.
