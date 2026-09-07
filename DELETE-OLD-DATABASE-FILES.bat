@echo off
setlocal
cd /d "%~dp0public\database"

echo.
echo ============================================================
echo  Cleaning public\database
echo ============================================================
echo.
echo These 11 superseded files will be deleted:
echo.
echo    database.sql
echo    stored_Procedure.sql
echo    fix_patch.sql
echo    upgrade.sql
echo    upgrade_v2.sql
echo    upgrade_v3.sql
echo    upgrade_v4.sql
echo    upgrade_v5.sql
echo    upgrade_v6.sql
echo    upgrade_v7.sql
echo    upgrade_v8.sql
echo.
echo The three files that replace them are already in place:
echo.
echo    0-READ-ME-FIRST.md
echo    1-RUN-FIRST-database.sql
echo    2-RUN-SECOND-stored-procedures.sql
echo.
echo Nothing is lost: every change the upgrade files made is already
echo inside 1-RUN-FIRST-database.sql, and git history still has them.
echo.
echo Press Ctrl+C to cancel, or
pause

del /q database.sql 2>nul
del /q stored_Procedure.sql 2>nul
del /q fix_patch.sql 2>nul
del /q upgrade.sql 2>nul
del /q upgrade_v2.sql 2>nul
del /q upgrade_v3.sql 2>nul
del /q upgrade_v4.sql 2>nul
del /q upgrade_v5.sql 2>nul
del /q upgrade_v6.sql 2>nul
del /q upgrade_v7.sql 2>nul
del /q upgrade_v8.sql 2>nul

echo.
echo ============================================================
echo  Done. public\database now contains:
echo ============================================================
echo.
dir /b
echo.
echo This script deletes itself when you close this window.
echo.
pause

del "%~f0"
