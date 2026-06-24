# Homebrew formula for the Minima CLI (the `minima` agent).
#
# This is a SCAFFOLD. Fill in after the package is published (see packaging/homebrew/README.md):
#   1. `url` + `sha256` — the published `minima-cli` sdist (PyPI, or a GitHub Release asset).
#   2. the `resource` blocks — every transitive dependency, vendored for offline install.
#
# Once filled, it lives in the tap repo `mubit-ai/homebrew-minima` as `Formula/minima.rb`:
#       brew install mubit-ai/minima/minima
#
# psycopg2-binary is NOT pulled in (server stack lives in the `[server]` extra), so the CLI
# install is lean — no Postgres/web-server deps.

class Minima < Formula
  include Language::Python::Virtualenv

  desc "Minima CLI: cost-aware LLM model-routing coding agent"
  homepage "https://docs.minima.sh"
  url "https://files.pythonhosted.org/packages/source/m/minima-cli/minima_cli-0.4.0.tar.gz"
  sha256 "REPLACE_WITH_SDIST_SHA256_AFTER_PUBLISH"
  license "FSL-1.1-Apache-2.0"

  depends_on "python@3.13"

  # Generate/refresh AFTER setting url + sha256:  brew update-python-resources Formula/minima.rb
  # The CLI needs the `harness` + `tui` extras (anthropic, google-genai, textual, keyring, deps) —
  # ensure those resources are present (generate against `minima-cli[harness,tui]`).
  # resource "httpx" do ... end
  # resource "pydantic" do ... end
  # resource "mubit-sdk" do ... end
  # resource "textual" do ... end
  # resource "anthropic" do ... end
  # resource "google-genai" do ... end
  # resource "keyring" do ... end
  # ... (full transitive closure) ...

  def install
    venv = virtualenv_create(libexec, "python3.13")
    venv.pip_install resources
    # install the CLI extras; provides the `minima` (and `minima-harness`) console scripts.
    venv.pip_install_and_link "#{buildpath}[harness,tui]"
  end

  test do
    assert_match "usage: minima", shell_output("#{bin}/minima --help")
    # config store works with no keychain backend (file fallback), in an isolated HOME.
    ENV["HOME"] = testpath
    ENV["PYTHON_KEYRING_BACKEND"] = "keyring.backends.fail.Keyring"
    assert_match "LLM provider keys", shell_output("#{bin}/minima config list")
  end
end
