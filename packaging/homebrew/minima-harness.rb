# Homebrew formula for the Minima harness CLI.
#
# This is a SCAFFOLD. Two things must be filled in after the package is published to PyPI
# (see packaging/homebrew/README.md for the full workflow):
#   1. `url` + `sha256` — point at the published sdist on PyPI.
#   2. the `resource` blocks — auto-generated, they vendor every transitive dependency
#      (Homebrew installs offline from these, it does not resolve from PyPI at install time).
#
# Once filled, this lives in the tap repo `mubit-ai/homebrew-minima` as
# `Formula/minima-harness.rb`, and users install with:
#       brew install mubit-ai/minima/minima-harness
#
# psycopg2-binary ships prebuilt wheels, so no `depends_on "postgresql"` is needed.

class MinimaHarness < Formula
  include Language::Python::Virtualenv

  desc "Cost-aware LLM model-routing coding agent (Minima harness)"
  homepage "https://docs.minima.sh"
  url "https://files.pythonhosted.org/packages/source/m/minima/minima-0.4.0.tar.gz"
  sha256 "REPLACE_WITH_SDIST_SHA256_AFTER_PUBLISH"
  license "FSL-1.1-Apache-2.0"

  depends_on "python@3.13"

  # ---------------------------------------------------------------------------
  # Vendored dependencies. Generate/refresh these AFTER setting url + sha256:
  #
  #   brew update-python-resources Formula/minima-harness.rb
  #
  # NOTE: `update-python-resources` only follows the package's *core* dependencies.
  # The harness CLI also needs the `harness` + `tui` extras — make sure these resources
  # are present (add them by also running the generator against `minima[harness,tui]`,
  # or with `pip download`): anthropic, google-genai, textual, keyring, and their deps.
  #
  # resource "httpx" do ... end
  # resource "pydantic" do ... end
  # resource "mubit-sdk" do ... end
  # resource "textual" do ... end
  # resource "anthropic" do ... end
  # resource "google-genai" do ... end
  # resource "keyring" do ... end
  # ... (full transitive closure) ...
  # ---------------------------------------------------------------------------

  def install
    # Install the package together with the CLI extras into an isolated virtualenv,
    # along with all vendored resources above. The `minima-harness` console script is
    # symlinked into Homebrew's bin.
    venv = virtualenv_create(libexec, "python3.13")
    venv.pip_install resources
    venv.pip_install_and_link "#{buildpath}[harness,tui]"
  end

  test do
    # The CLI must at least start and print usage without any credentials configured.
    assert_match "minima-harness", shell_output("#{bin}/minima-harness --help")
    # Config store works with no keychain backend (file fallback), in an isolated HOME.
    ENV["HOME"] = testpath
    ENV["PYTHON_KEYRING_BACKEND"] = "keyring.backends.fail.Keyring"
    assert_match "LLM provider keys", shell_output("#{bin}/minima-harness config list")
  end
end
