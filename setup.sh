#!/usr/bin/env bash
set -euo pipefail

# Ultrawork - One-click setup script
# Usage: ./setup.sh [--dev | --build]
#   --dev           : Setup + start dev server (default)
#   --build         : Setup + build release package
#   --force-build   : Force rebuild all sidecars (skip incremental cache)

MODE="${1:---dev}"
FORCE_BUILD=""
# --force-build forces sidecar rebuild even if sources unchanged
for arg in "$@"; do
  if [ "$arg" = "--force-build" ]; then
    FORCE_BUILD="--force"
  fi
done
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo "  Ultrawork Setup"
echo "========================================"

# ── 1. Check prerequisites ──────────────────

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: $1 is not installed."
    echo "  $2"
    exit 1
  fi
}

check_cmd bun    "Install: curl -fsSL https://bun.sh/install | bash"
check_cmd cargo  "Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"

# On Apple Silicon, the universal DMG build needs the x86_64 Rust target too.
# Idempotent — rustup is a no-op if already installed.
if [ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  if command -v rustup &>/dev/null; then
    if ! rustup target list --installed 2>/dev/null | grep -q "^x86_64-apple-darwin$"; then
      echo "  Installing Rust target x86_64-apple-darwin (needed for Universal DMG)..."
      rustup target add x86_64-apple-darwin
    fi
  fi
fi

echo "[1/6] Prerequisites OK (bun, cargo)"

# ── 2. Init submodules ──────────────────────

if [ ! -d "$ROOT_DIR/vendor/opencode/packages" ]; then
  echo "[2/6] Initializing git submodules..."
  git submodule update --init --recursive
else
  echo "[2/6] Submodules already initialized"
fi

# ── 3. Apply vendor patches ─────────────────

PATCH_DIR="$ROOT_DIR/patches"
VENDOR_DIR="$ROOT_DIR/vendor/opencode"

if [ -d "$PATCH_DIR" ]; then
  echo "[3/6] Applying vendor patches..."
  for patch in "$PATCH_DIR"/vendor-opencode-*.patch; do
    [ -f "$patch" ] || continue
    PATCH_NAME="$(basename "$patch")"
    if (cd "$VENDOR_DIR" && git apply --check "$ROOT_DIR/patches/$PATCH_NAME" 2>/dev/null); then
      (cd "$VENDOR_DIR" && git apply "$ROOT_DIR/patches/$PATCH_NAME")
      echo "  Applied: $PATCH_NAME"
    else
      echo "  Skipped (already applied or conflict): $PATCH_NAME"
    fi
  done
else
  echo "[3/6] No patches to apply"
fi

# ── 4. Install dependencies ─────────────────

echo "[4/6] Installing dependencies..."
bun install

# Install vendor/opencode dependencies (needed for build preload resolution)
echo "  Installing vendor/opencode dependencies..."
(cd "$VENDOR_DIR" && bun install)

# ── 5. Build sidecar binaries ───────────────

BINARIES_DIR="$ROOT_DIR/packages/client/desktop/src-tauri/binaries"

echo "[5/6] Building sidecar binaries..."
mkdir -p "$BINARIES_DIR"

echo "  Building OpenCode server..."
bun run build:opencode $FORCE_BUILD

echo "  Building Channel Gateway..."
bun run build:gateway $FORCE_BUILD

echo "  Building Knowledge Sidecar..."
bun run build:knowledge $FORCE_BUILD

echo "  Building ACP Client..."
bun run build:acp $FORCE_BUILD

echo "  Sidecar binaries ready in src-tauri/binaries/"

# ── 6. Dev or Build ─────────────────────────

# Clean stale dev instances before starting a new one. The Rust reaper already
# handles orphan sidecars on 4096-4099 at app startup, but nothing guards the
# Vite port (1420): a previous dev instance still alive (or its detached vite)
# makes the new `tauri dev` fail with "Port 1420 is already in use".
cleanup_stale_dev() {
  command -v lsof &>/dev/null || return 0
  local vite_pids app_pids stale
  vite_pids="$(lsof -nP -tiTCP:1420 -sTCP:LISTEN 2>/dev/null || true)"
  app_pids="$(pgrep -f "$ROOT_DIR/packages/client/desktop/src-tauri/target/debug/ultrawork" 2>/dev/null || true)"
  stale="$(printf '%s\n%s\n' "$vite_pids" "$app_pids" | sort -u | grep -v '^$' || true)"
  [ -z "$stale" ] && return 0

  echo "  WARNING: a previous dev instance is still running — cleaning it up first:"
  for pid in $stale; do
    echo "    killing pid $pid ($(ps -p "$pid" -o comm= 2>/dev/null | xargs basename 2>/dev/null || echo '?'))"
    kill "$pid" 2>/dev/null || true
  done
  # Graceful TERM lets the app's shutdown hook clean its own sidecars; escalate
  # only if something still holds the port after a short grace period.
  sleep 2
  local left
  left="$(lsof -nP -tiTCP:1420 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$left" ]; then
    echo "    port 1420 still held, force-killing: $left"
    kill -9 $left 2>/dev/null || true
    sleep 1
  fi
  echo "  Stale dev instance cleaned."
}

case "$MODE" in
  --dev)
    echo "[6/6] Starting dev server..."
    cleanup_stale_dev
    echo ""
    echo "  Frontend:  http://localhost:1420"
    echo "  OpenCode:  http://localhost:4096"
    echo "  Gateway:   http://localhost:4097"
    echo "  Knowledge: http://localhost:4098"
    echo "  ACP:       http://localhost:4099"
    echo ""
    bun run tauri:dev
    ;;
  --build)
    echo "[6/6] Building release package..."
    bun run tauri:build
    echo ""
    echo "Build complete! Check packages/client/desktop/src-tauri/target/release/bundle/"
    ;;
  *)
    echo "[6/6] Setup complete!"
    echo ""
    echo "Next steps:"
    echo "  bun run tauri:dev    # Start dev server"
    echo "  bun run tauri:build  # Build release package"
    ;;
esac
