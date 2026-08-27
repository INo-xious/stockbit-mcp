#!/usr/bin/env bash
# One full verification cycle. Exits non-zero on the first real failure.
#
# The browser-driven tests in the suite are load-flaky on Windows and macOS runners (they launch
# headless Chrome and contend), so a single red run is not evidence of a defect. The suite is
# retried once and only a REPEATED failure counts — that is the difference between a flake and a
# regression, and conflating them would either hide a real bug or block a release on noise.
set -u
cd "$(dirname "$0")/.."
export STOCKBIT_NO_BROWSER=1 STOCKBIT_FORCE_FILE_STORE=1
fail=0
step() { printf '  %-22s' "$1"; shift; if "$@" >/tmp/fc.log 2>&1; then echo "OK"; else echo "FAIL"; fail=1; tail -5 /tmp/fc.log | sed 's/^/      /'; fi; }

step "typecheck" npm run typecheck
step "build"     npm run build

printf '  %-22s' "test suite"
if npm test >/tmp/fc-test.log 2>&1; then echo "OK"
else
  printf 'retry… '
  if npm test >/tmp/fc-test.log 2>&1; then echo "OK (first run flaked)"
  else echo "FAIL"; fail=1; grep -E "^✖ [a-z]|^ℹ (tests|pass|fail)" /tmp/fc-test.log | head -6 | sed 's/^/      /'; fi
fi

step "smoke"       npm run smoke
step "check:pack"  npm run check:pack
step "docs fresh"  bash -c 'npm run docs:tools >/dev/null 2>&1 && git diff --exit-code docs/TOOLS.md'
step "browser+login" node scripts/verify-default-browser.cjs
exit $fail
