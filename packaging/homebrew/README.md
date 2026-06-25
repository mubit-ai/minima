# Homebrew distribution

`minima-harness` (the TUI coding agent) can be installed via Homebrew from a custom tap.
A formula vendors every dependency and installs into an isolated virtualenv, so it does not
touch the system Python.

> **Prerequisite: the package must be on PyPI first.** A Homebrew formula points `url` at a
> published sdist and installs its dependencies *offline* from vendored `resource` blocks — so
> there is nothing to install until `minima` is published. See `docs/publishing.md`.

## One-time: create the tap repo

Homebrew taps are GitHub repos named `homebrew-<tap>`. Create:

```
github.com/mubit-ai/homebrew-minima
└── Formula/
    └── minima.rb     # copied from packaging/homebrew/minima.rb
```

Users then install with:

```bash
brew install mubit-ai/minima/minima
# or:  brew tap mubit-ai/minima && brew install minima
```

## Finalizing the formula after each release

1. **Publish to PyPI** (`uv build` → `twine upload dist/*`) so the sdist exists.
2. **Set `url` + `sha256`** in the formula to the published sdist. Get the hash:
   ```bash
   curl -sL https://files.pythonhosted.org/packages/source/m/minima-cli/minima_cli-<version>.tar.gz \
     | shasum -a 256
   ```
3. **Generate the vendored resources** (the transitive dependency closure):
   ```bash
   brew update-python-resources Formula/minima.rb
   ```
   `update-python-resources` only follows the package's **core** dependencies. The harness CLI
   also needs the `harness` + `tui` extras (anthropic, google-genai, textual, keyring, and their
   deps) — make sure those `resource` blocks are present. The reliable way is to generate from a
   spec that includes the extras, e.g. with a venv:
   ```bash
   python -m venv /tmp/poet && /tmp/poet/bin/pip install homebrew-pypi-poet "minima-cli[harness,tui]==<version>"
   /tmp/poet/bin/poet minima > resources.rb   # then paste the resource blocks into the formula
   ```
4. **Re-apply prebuilt wheels for the compiled deps** — see "Compiled deps must use wheels" below.
   `update-python-resources` emits **sdists** for every package, which re-introduces the slow
   source build. After step 3, run `python packaging/homebrew/wheel_urls.py` and replace the
   `grpcio`/`protobuf`/`cffi`/`jiter`/`pydantic-core`/`cryptography`/`websockets` resources with
   the wheel URLs it prints. **This step is mandatory every release** — skipping it regresses
   install to ~5 min.
5. **Audit + test locally** before pushing the tap:
   ```bash
   brew reinstall ./Formula/minima.rb   # or: brew install
   brew test minima
   brew audit --strict --online minima   # advisory: it flags wheel resources; that's expected
   ```
   Sanity-check that no compiler ran (the bug this guards against):
   ```bash
   pgrep -fl 'clang|rustc|cargo'   # must print nothing during the install on Apple Silicon
   ```
6. Commit the formula to `mubit-ai/homebrew-minima` and tag the release.

## Compiled deps must use wheels (critical — do not skip)

Seven dependencies have C/Rust extensions: `grpcio`, `protobuf`, `cffi`, `jiter`, `pydantic-core`,
`cryptography`, and `websockets` (an optional C speedup). Homebrew's `std_pip_args` hardcodes
**`--no-binary=:all:`**, so the default `virtualenv_install_with_resources` *compiles every one
from source* — a ~5 min install with a heavy CPU/RAM spike (grpcio alone spawns a storm of
`clang` jobs). The formula avoids this:

- Those six `resource` blocks point at **prebuilt wheels** (`.whl`), not sdists.
- `def install` installs them via an explicit `pip install` **without** `--no-binary`, pointing
  pip at the cached wheel files (copied back to their clean filenames first — brew's
  `<sha256>--` cache prefix otherwise breaks pip's wheel-name parser). Everything else
  (pure-Python) installs normally; the CLI itself installs last.
- `preserve_rpath` is set: jiter/pydantic-core wheels ship `.so` modules with `@rpath` dylib IDs
  and no header padding, which otherwise fails Homebrew's relocation ("load commands do not fit").
- **Intel caveat:** `cryptography` publishes no x86_64 macOS wheel, so on Intel it falls back to
  the sdist (built from source) — hence `rust` + `openssl@3` are declared inside `on_intel`.
  Apple Silicon installs entirely from wheels with no build toolchain.

Result: install drops from ~5 min to under ~90s and the compiler/RAM spike is gone. The wheel
URLs are version-specific — regenerate them with `packaging/homebrew/wheel_urls.py` each release.

## Lean by design

The server stack (`fastapi`, `uvicorn`, `psycopg2-binary`, `redis`) lives in the `[server]`
optional-dependency group, not core — so `minima-cli[harness,tui]` (what this formula installs) pulls
**no** web framework or Postgres/Redis drivers. That keeps the formula small. The CLI still has
compiled deps (see above), which is why they are vendored as wheels rather than built from source.
The server's own install path (the in-repo `Dockerfile` → Cloud Run) uses `uv sync --extra server`,
so this split doesn't affect the hosted deployment.
