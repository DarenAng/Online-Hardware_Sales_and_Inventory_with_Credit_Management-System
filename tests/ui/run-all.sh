#!/bin/sh
# Drives every screen in a real browser against the stub in tests/ui/stub.js,
# with no database anywhere:
#     sh tests/ui/run-all.sh
# Needs Playwright, the same as tests/shots.js:
#     npm install --no-save playwright
#     npx playwright install chromium
# Screenshots of every step land in shots/ui/.
# ==========================================================================
set -e

DIR=$(dirname "$0")
PORT=${PORT:-3311}
export BASE="http://localhost:$PORT"

echo "Starting the stub on port $PORT..."
node "$DIR/stub.js" &
STUB=$!

# stop the stub whichever way this script ends
trap 'kill $STUB 2>/dev/null || true' EXIT INT TERM

sleep 2

FAILED=0

for SUITE in admin manager credit returns filters lazy-loading live-sync; do
  echo ""
  echo "=================================================="
  echo "  $SUITE"
  echo "=================================================="
  node "$DIR/$SUITE.js" || FAILED=1
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "Every screen behaved. Screenshots are in shots/ui/."
else
  echo "Something did not behave. The failing lines are above."
fi

exit "$FAILED"
