#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point for the cross-platform setup implementation.
# Usage: ./setup.sh [--dev | --build] [--force-build] [brand options]
# No mode defaults to --dev. Brand options are the same as `bun run setup`.
# Keep the caller's cwd so relative brand and icon paths resolve consistently.
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun is not installed. Install it from https://bun.sh" >&2
  exit 1
fi

exec bun run --bun "$ROOT_DIR/scripts/setup.ts" "$@"
