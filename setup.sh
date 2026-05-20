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

echo "  Sidecar binaries ready in src-tauri/binaries/"

# ── 6. Dev or Build ─────────────────────────

case "$MODE" in
  --dev)
    echo "[6/6] Starting dev server..."
    echo ""
    echo "  Frontend:  http://localhost:1420"
    echo "  OpenCode:  http://localhost:4096"
    echo "  Gateway:   http://localhost:4097"
    echo "  Knowledge: http://localhost:4098"
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
