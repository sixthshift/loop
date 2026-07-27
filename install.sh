#!/usr/bin/env bash
# Install loop from a GitHub release. Re-running it is the upgrade path.
#
#   curl -fsSL https://raw.githubusercontent.com/sixthshift/loop/main/install.sh | bash
#
# Honours LOOP_VERSION (a release tag, e.g. v0.1.0) to pin, and LOOP_BIN_DIR to
# install somewhere other than ~/.local/bin.
set -euo pipefail

REPO="sixthshift/loop"
BIN_DIR="${LOOP_BIN_DIR:-$HOME/.local/bin}"

die() { printf 'loop: %s\n' "$1" >&2; exit 1; }
warn() { printf 'loop: %s\n' "$1" >&2; }

for cmd in curl uname mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
done

# uname -sm → release asset name. Anything else has no binary to download; say so
# rather than fetching a 404 and installing an HTML error page.
case "$(uname -sm)" in
  'Darwin arm64')          asset='loop-darwin-arm64' ;;
  'Darwin x86_64')         asset='loop-darwin-x64' ;;
  'Linux x86_64')          asset='loop-linux-x64' ;;
  'Linux aarch64'|'Linux arm64') asset='loop-linux-arm64' ;;
  *) die "no prebuilt binary for $(uname -sm) — build from source: https://github.com/$REPO" ;;
esac

if [ -n "${LOOP_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$LOOP_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'loop: downloading %s\n' "$asset"
curl -fsSL "$base/$asset" -o "$tmp/$asset" \
  || die "download failed — check that ${LOOP_VERSION:-the latest release} publishes $asset"
curl -fsSL "$base/sha256sums.txt" -o "$tmp/sha256sums.txt" \
  || die 'could not fetch sha256sums.txt'

# Verify before anything lands on PATH. The sums file covers every asset, so
# reduce it to this one — sha256sum -c fails on the absent siblings otherwise.
expected="$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/sha256sums.txt")"
[ -n "$expected" ] || die "sha256sums.txt has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
else
  die 'neither sha256sum nor shasum found — cannot verify the download'
fi
[ "$actual" = "$expected" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir -p "$BIN_DIR"
chmod +x "$tmp/$asset"
# Atomic: a running loop keeps its inode, and an interrupted install never leaves
# a half-written binary on PATH. mv across filesystems isn't atomic, so stage the
# temp copy inside the destination dir first.
mv -f "$tmp/$asset" "$BIN_DIR/.loop.new"
mv -f "$BIN_DIR/.loop.new" "$BIN_DIR/loop"

printf 'loop: installed %s to %s/loop\n' "$("$BIN_DIR/loop" --version)" "$BIN_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add it: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# loop drives real agent CLIs in real git worktrees; both are hard requirements a
# campaign would otherwise discover at its first ticket, several minutes in.
command -v git >/dev/null 2>&1 || warn 'git not found — loop needs it to create campaign worktrees'
if ! command -v claude >/dev/null 2>&1 && ! command -v codex >/dev/null 2>&1; then
  warn 'neither claude nor codex found — loop spawns one of them per agent; install and authenticate at least one'
fi
