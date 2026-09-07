# public/database/

Two files. Run them in the order the names give.

| File | What it is | When you run it |
|---|---|---|
| `1-RUN-FIRST-database.sql` | The whole schema — 23 tables, 2 views, demo data | Setting up a new machine, or resetting one back to demo data |
| `2-RUN-SECOND-stored-procedures.sql` | The 24 stored procedures the app calls | Straight after file 1, and again any time a procedure changes |

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

File 2 is different: it only drops and recreates procedures, so it is always
safe to re-run on its own. If the server starts up complaining that a
`PROCEDURE does not exist`, running file 2 again is the fix.

## Where the upgrade files went

Earlier versions of the project shipped `upgrade.sql` through
`upgrade_v8.sql` and `fix_patch.sql` alongside the schema. They existed to
move a database that already held real data from one version to the next,
one step at a time.

Every change they made is now inside `1-RUN-FIRST-database.sql`, so on any
machine that runs the schema fresh they did nothing at all — the columns,
views and tables they added were already there. They have been removed. Git
history still has them if an old database ever needs stepping forward.
