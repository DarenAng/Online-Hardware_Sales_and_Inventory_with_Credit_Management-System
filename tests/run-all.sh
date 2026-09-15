#!/bin/sh
# Rebuilds the database from the two SQL files, restarts the server, then runs
# the API checks, the fixed-bug checks and the screen tour from a known state.
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
# mail off, so the passwords the server makes come back in its replies
  # rather than going to an inbox the checks cannot read
  HARDWARE_MAIL_OFF=1 nohup node public/javascript/server.js > /tmp/hardware-server.log 2>&1 &
  echo $! > /tmp/hardware-server.pid
  sleep 4
  cat /tmp/hardware-server.log
}
# the SMTP client talks to a fake mail server, so it needs neither MySQL nor the server
# nothing about whether MySQL is up.
echo "== sending mail =="
node tests/mailer.js

echo ""
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
