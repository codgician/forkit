#!/usr/bin/env bash
set -euo pipefail
exec nix develop --impure --file "$FORKIT_CONFIG_DIR/validation.nix" \
  --command bash "$FORKIT_CONFIG_DIR/validate-in-shell.sh"
