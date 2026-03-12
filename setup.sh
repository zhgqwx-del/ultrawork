#!/usr/bin/env bash
set -euo pipefail

# Ultrawork - One-click setup script
# Usage: ./setup.sh [--dev | --build]
#   --dev   : Setup + start dev server (default)
#   --build : Setup + build release package

MODE="${1:---dev}"
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

build_sidecars() {
  echo "[5/6] Building sidecar binaries (this may take a few minutes)..."

  echo "  Building OpenCode server..."
  bun run build:opencode

  echo "  Building Channel Gateway..."
  bun run build:gateway

  echo "  Sidecar binaries ready in src-tauri/binaries/"
}

if [ -d "$BINARIES_DIR" ] && ls "$BINARIES_DIR"/opencode-server-* &>/dev/null; then
  echo "[5/6] Sidecar binaries already exist, skipping build"
  echo "  (delete src-tauri/binaries/ and re-run to force rebuild)"
else
  build_sidecars
fi

# ── 6. Dev or Build ─────────────────────────

case "$MODE" in
  --dev)
    echo "[6/6] Starting dev server..."
    echo ""
    echo "  Frontend: http://localhost:1420"
    echo "  OpenCode: http://localhost:4096"
    echo "  Gateway:  http://localhost:4097"
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
