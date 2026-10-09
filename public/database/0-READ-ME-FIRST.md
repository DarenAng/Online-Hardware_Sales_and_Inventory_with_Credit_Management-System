# public/database/

Two files to set up, run in the order the names give, and one upgrade file.

| File | What it is | When you run it |
|---|---|---|
| `1-RUN-FIRST-database.sql` | The whole schema — 33 tables (6 of them the server's own: sign-ins, live updates, stored backups), the demo data, and six months of mock trading | Setting up a new machine, or resetting one back to the demo and mock data |
| `2-RUN-SECOND-stored-procedures.sql` | The 3 views and the 36 stored procedures the app uses | Straight after file 1, and again any time a view or a procedure changes |
| `3-ADD-qr-payments.sql` | The `qr_payments` table, for a database made before QR payments | Once, on a database that already holds real data; then file 2 (or restart the server) |

## In MySQL Workbench

1. Open Workbench and connect to your local MySQL server.
2. **File → Open SQL Script…**, pick `1-RUN-FIRST-database.sql`, click the
   lightning bolt to run it.
3. Do the same with `2-RUN-SECOND-stored-procedures.sql`.

That is the whole setup. Then `npm install` and `npm start` in the project
root.

## On the command line

```bash
mysql -u root -p < public/database/1-RUN-FIRST-database.sql
mysql -u root -p < public/database/2-RUN-SECOND-stored-procedures.sql
```

## Before you run file 1

Its first statement is `DROP DATABASE IF EXISTS hardware_db`. It destroys
whatever is in `hardware_db` and puts the demo data back. On a machine
holding work you want to keep, take a backup first — the System
Administrator's **Backup & Recovery** screen writes one into `backups/`.

File 2 is different: it only drops and recreates the views and procedures,
so it is always safe to re-run on its own. The server also runs it for you: on
start-up, if the database holds fewer procedures than the code expects, it
loads this file itself and says so in the terminal. So if a screen ever says
"this database has N of M stored procedures", restart the server.

One thing to watch in Workbench: it executes the text in the open tab, not the
file on disk. After the file changes, close the tab and open the file again
(File → Open SQL Script), or run it from the command line above.

## Where the upgrade files went

Earlier versions of the project shipped `upgrade.sql` through
`upgrade_v8.sql` and `fix_patch.sql` alongside the schema. They existed to
move a database that already held real data from one version to the next,
one step at a time.

Every change they made is now inside `1-RUN-FIRST-database.sql`, so on any
machine that runs the schema fresh they did nothing at all — the columns,
views and tables they added were already there. They have been removed. Git
history still has them if an old database ever needs stepping forward.
