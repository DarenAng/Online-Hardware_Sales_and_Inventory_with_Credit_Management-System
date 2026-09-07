#!/bin/sh
# Rebuilds the database from the two SQL files, restarts the server, then runs
# the API checks, the fixed-bug checks and the screen tour. Each suite starts
# from the same known state, so a failure means a real change and not leftovers
# from last time.
set -e

cd "$(dirname "$0")/.."

MYSQL_USER=${MYSQL_USER:-root}
MYSQL_PASSWORD=${MYSQL_PASSWORD:-Password}
SHOTS=${SHOTS:-shots/current}

reset_everything() {
  mysql -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" < public/database/1-RUN-FIRST-database.sql
  mysql -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" < public/database/2-RUN-SECOND-stored-procedures.sql

  if [ -f /tmp/hardware-server.pid ]; then
    kill "$(cat /tmp/hardware-server.pid)" 2>/dev/null || true
    sleep 1
  fi

  nohup node public/javascript/server.js > /tmp/hardware-server.log 2>&1 &
  echo $! > /tmp/hardware-server.pid
  sleep 4
  cat /tmp/hardware-server.log
}

echo "== API checks =="
reset_everything
node tests/smoke.js

echo ""
echo "== fixed bugs, still fixed =="
reset_everything
node tests/regression.js

echo ""
echo "== screen tour =="
reset_everything
OUT="$PWD/$SHOTS" node tests/shots.js
