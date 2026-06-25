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

  # rust + openssl are only needed on Intel, where `cryptography` has no published x86_64
  # wheel and must build from source. Apple Silicon installs entirely from wheels (below).
  on_intel do
    depends_on "rust" => :build
    depends_on "openssl@3"
  end

  # jiter/pydantic-core wheels ship `.so` modules with `@rpath` dylib IDs and no header
  # padding; preserve_rpath stops Homebrew's relocation from failing on them. See README.md.
  preserve_rpath

  # Generate/refresh AFTER setting url + sha256:  brew update-python-resources Formula/minima.rb
  # The CLI needs the `harness` + `tui` extras (anthropic, google-genai, textual, keyring, deps) —
  # ensure those resources are present (generate against `minima-cli[harness,tui]`).
  #
  # CRITICAL: the six compiled deps (grpcio, protobuf, cffi, jiter, pydantic-core, cryptography)
  # MUST be vendored as prebuilt WHEELS, not the sdists update-python-resources emits — otherwise
  # Homebrew's `--no-binary=:all:` compiles them from source (~5 min install + RAM spike). Get the
  # wheel resource blocks from `python packaging/homebrew/wheel_urls.py <pkg>==<ver> ...`.
  # resource "httpx" do ... end          # pure-Python → sdist is fine
  # resource "grpcio" do ... end          # COMPILED → wheel (see wheel_urls.py)
  # resource "pydantic-core" do ... end    # COMPILED → wheel (on_arm/on_intel)
  # ... (full transitive closure) ...

  def install
    python = "python3.13"
    venv = virtualenv_create(libexec, python)

    # Install the compiled deps from their vendored wheels WITHOUT --no-binary (Homebrew's
    # std_pip_args forces --no-binary=:all:, which would recompile them). brew caches downloads
    # as `<sha256>--<name>`; pip's wheel parser rejects that prefix, so copy to a clean name.
    wheels = %w[grpcio protobuf cffi jiter pydantic-core websockets]
    wheels << "cryptography" if Hardware::CPU.arm? # Intel has no x86_64 wheel → builds from source
    wheelhouse = buildpath/"wheelhouse"
    wheelhouse.mkpath
    wheel_files = wheels.map do |name|
      r = resource(name)
      dest = wheelhouse/File.basename(r.url)
      cp r.cached_download, dest
      dest
    end
    system python, "-m", "pip", "--python=#{libexec}/bin/python", "install",
           "--no-deps", "--no-index", "--ignore-installed", "--no-compile", *wheel_files

    # Everything else is pure-Python; then the CLI (provides `minima` / `minima-harness`).
    venv.pip_install resources.reject { |r| wheels.include?(r.name) }
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
