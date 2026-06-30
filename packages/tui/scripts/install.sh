#!/usr/bin/env bash
# install — download the latest minima native binary from GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/mubit-ai/minima/main/packages/tui/scripts/install.sh | bash
#
# Mirrors the shape used by opencode/charm tools. Respects $OPENCODE_INSTALL_DIR-style
# override via $MINIMA_INSTALL_DIR, falling back to $XDG_BIN_DIR, $HOME/bin, then
# $HOME/.minima/bin.

set -euo pipefail

REPO="mubit-ai/minima"
ASSET_PREFIX="minima"

err() { printf "install: %s\n" "$*" >&2; exit 1; }

command -v curl >/dev/null || err "curl is required"
command -v unzip >/dev/null || err "unzip is required"

case "$(uname -s)" in
  Darwin*) OS="macos" ;;
  Linux*)  OS="linux" ;;
  *)       err "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *)             err "unsupported arch: $(uname -m)" ;;
esac

INSTALL_DIR="${MINIMA_INSTALL_DIR:-${XDG_BIN_DIR:-}}"
if [ -z "$INSTALL_DIR" ]; then
  if [ -d "$HOME/bin" ] || mkdir -p "$HOME/bin" 2>/dev/null; then
    INSTALL_DIR="$HOME/bin"
  else
    INSTALL_DIR="$HOME/.minima/bin"
  fi
fi
mkdir -p "$INSTALL_DIR"

# Resolve the latest release tag (GitHub API redirect).
TAG="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"
TAG="${TAG##*/}"
[ -n "$TAG" ] || err "could not determine latest release"

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_PREFIX}-${OS}-${ARCH}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ downloading minima ${TAG} (${OS}/${ARCH})"
curl -fsSL -o "${TMP}/minima" "$URL" || err "download failed: $URL"
chmod +x "${TMP}/minima"
mv "${TMP}/minima" "${INSTALL_DIR}/minima"

echo "✓ installed minima → ${INSTALL_DIR}/minima"
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "  (add ${INSTALL_DIR} to your PATH)" ;;
esac
