# backups/

Dated `.sql` backups written by the System Administrator's Backup & Recovery
screen land here, one file per backup:

    hardware_db_backup_2026-09-04_1407.sql

Each file holds the whole system — every table, every row, both views and all
eighteen stored procedures — and runs in MySQL Workbench as well as through the
Recovery screen.

The files themselves are not tracked by git (see `.gitignore`); this note is,
so the folder exists on a fresh copy of the project.
