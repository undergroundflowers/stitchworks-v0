#!/usr/bin/env bash
# Colour-literal ratchet — keeps hardcoded hex/rgb() values in the UI from
# creeping back in. New colours belong in src/design/tokens.ts (or derive
# via alpha()/darken() from src/design/color-utils.ts).
#
# Counts colour literals in the UI trees and fails if the count EXCEEDS the
# checked-in baseline (scripts/color-baseline.txt). When you remove literals,
# run with --update to lower the baseline; raising it should be a deliberate,
# reviewed act.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE="scripts/color-baseline.txt"

count_literals() {
  grep -rEoh '#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b|#[0-9a-fA-F]{3}\b|rgba?\(' \
    src/pages src/components src/shell src/App.tsx \
    --include='*.ts' --include='*.tsx' \
    --exclude='ProcessCodeView.tsx' \
    | wc -l | tr -d ' '
}

CURRENT="$(count_literals)"

if [[ "${1:-}" == "--update" ]]; then
  echo "$CURRENT" > "$BASELINE_FILE"
  echo "color-literals: baseline set to $CURRENT"
  exit 0
fi

if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "color-literals: no baseline found — run scripts/check-color-literals.sh --update" >&2
  exit 1
fi

BASELINE="$(tr -d '[:space:]' < "$BASELINE_FILE")"

if (( CURRENT > BASELINE )); then
  echo "color-literals: FAIL — $CURRENT literals (baseline $BASELINE)." >&2
  echo "Use SW_COLORS / alpha() from src/design instead, or update the baseline deliberately." >&2
  exit 1
fi

echo "color-literals: OK — $CURRENT literals (baseline $BASELINE)."
