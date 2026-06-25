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
