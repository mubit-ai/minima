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
3. **Generate the vendored resources as WHEELS** (not sdists — this is what keeps install fast):
   ```bash
   # First get the sdist closure (versions) once, e.g. via homebrew-pypi-poet on the extras:
   python -m venv /tmp/poet && /tmp/poet/bin/pip install homebrew-pypi-poet "minima-cli[harness,tui]==<version>"
   /tmp/poet/bin/poet minima > /tmp/sdist-resources.rb   # paste these into the formula ONCE

   # Then convert every resource to a prebuilt wheel (per-arch) so users don't compile from source:
   python packaging/homebrew/gen_resources.py Formula/minima.rb > /tmp/wheel-resources.rb
   # paste /tmp/wheel-resources.rb in place of the resource blocks.
   ```
   **Why wheels:** with sdists, `grpcio` (C++), `cryptography`/`pydantic-core`/`jiter` (Rust) and
   `cffi` compile **on each user's machine** — ~5 minutes. Wheels are prebuilt, so install drops to
   seconds. `gen_resources.py` emits the universal `*-none-any.whl` for pure-Python deps and
   per-arch (`on_macos`/`on_linux` × `on_arm`/`on_intel`) cp313 wheels for compiled ones, falling
   back to the sdist only where no wheel is published (today: `cryptography` on macOS-Intel). Run it
   with `--check` to print a coverage report first.

   Because Apple Silicon + Linux install entirely from wheels, the `rust`/`openssl@3` **build deps
   are scoped to macOS-Intel only** (the one branch that still builds `cryptography` from source).
   Re-run the generator on every release so the pins/wheels track the new dependency closure.

   **CRITICAL — the custom `install` block (do not revert to `virtualenv_install_with_resources`):**
   Homebrew's `std_pip_args` hardcodes `--no-binary=:all:`, so the default install path would
   *refuse/recompile* every wheel resource, defeating the point. The formula therefore installs
   wheels with an explicit `pip install --no-index --no-deps` (no `--no-binary`), copying each
   cached download back to its clean filename first (brew caches as `<sha256>--<name>`, which
   pip's wheel parser rejects). It also sets `preserve_rpath` (jiter/pydantic-core `.so` files
   carry `@rpath` IDs that Homebrew's relocation pass fails on). Verified with:
   ```bash
   brew reinstall --formula ./Formula/minima.rb        # "built in N seconds", no compile
   pgrep -fl 'rustc|cargo|clang'                        # must print nothing on Apple Silicon
   ```
4. **Audit + test locally** before pushing the tap:
   ```bash
   brew install --build-from-source ./Formula/minima.rb
   brew test minima
   brew audit --strict --online minima   # custom-tap audits are advisory
   ```
5. Commit the formula to `mubit-ai/homebrew-minima` and tag the release.

## Lean by design

The server stack (`fastapi`, `uvicorn`, `psycopg2-binary`, `redis`) lives in the `[server]`
optional-dependency group, not core — so `minima-cli[harness,tui]` (what this formula installs) pulls
**no** web framework or Postgres/Redis drivers. That keeps the formula small and avoids compiled
build deps. The server's own install path (the in-repo `Dockerfile` → Cloud Run) uses
`uv sync --extra server`, so this split doesn't affect the hosted deployment.
