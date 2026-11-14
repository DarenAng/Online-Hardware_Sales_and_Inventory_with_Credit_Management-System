# Save point: moving the hosted database from Aiven to Azure (14 November 2026)

This file lets a new chat continue the work. It holds no passwords.

## Where things stand

- **The hosted site works again.** `https://ohsicms.vercel.app` (Vercel project
  `lucelyn-hardware`, team `darenang`) now uses an Azure database.
- **Azure database:** Azure for Students subscription, resource group
  `ohsicms`, server `ohsicms-lucelyn-db`
  (`ohsicms-lucelyn-db.mysql.database.azure.com`, port 3306), login
  `ohsicmsadmin`, MySQL 8.4, Burstable B1ms, 20 GB, region East Asia (Hong
  Kong). The firewall lets in every address because Vercel has no fixed one.
  The student subscription only allows Australia East, East Asia, India South
  Central, Japan East and Korea Central.
- **Data in Azure:** the demo data from `public/database/1-database.sql` and
  `2-stored-procedures.sql` (38 tables, 4 views, 37 procedures). Tested from
  the PC: sign-in, product list, a cash sale, sign-out. Only that was tested.
- **Accounts in Azure:** the five demo accounts, with their emails changed on
  14 November to the owner's Gmail addresses: `daren.ang20@gmail.com` is the
  System Administrator, `+1` the Manager, `+2` the Inventory Clerk, `+3` the
  Cashier, `+4` the Delivery Personnel. There is no `+5`. Each must choose a
  new password at its first sign-in. The starting passwords are still the demo
  ones in `public/database/1-database.sql` near line 621 (admin row for the
  administrator, manager row for `+1`, and so on).
- **Vercel settings changed:** `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_SSL_CA`
  (by Claude) and `DB_PASSWORD` (by the user), then redeployed.

## Why the old database stopped

The Aiven service `mysql-2fb49ede` (project `daren-bfcf`) is on Aiven's paid
Developer-1 plan. Its trial ended, so Aiven powered it off. Powering it on
needs a payment card; none is on file. The old staff accounts (Gmail
addresses) and old records exist only inside that service. No copy is on this
PC: the `backups` folder holds backups of the laptop's own database only.

## Still to do

1. **Decide about the old data.** Either add the staff accounts again by hand
   on the new site (sign in as `admin@hardware.com`, then Staff Accounts), or
   add a card to Aiven, power it on, copy the data, and power it off. Not
   decided yet.
2. **Change the Azure password.** The current one was pasted into a chat and
   is easy to guess. Azure portal → the server → Reset password, then put the
   new one in `.env.azure` (line 4) and in Vercel's `DB_PASSWORD`, and redeploy.
3. **Sign in to all five demo accounts** on the hosted site and choose new
   passwords.
4. **Commit and push.** Nothing from this work is committed. The user pushes;
   commits carry no Claude co-author line.
5. **Check the cost.** A few days after 13 November, open Cost Management in
   Azure and confirm it shows zero.

## Files from this work (all uncommitted)

| File | What it is |
|---|---|
| `vercel.json` | region changed from `sin1` to `hkg1`, to sit next to the database |
| `public/deployment/DEPLOY-VERCEL-AZURE.md` | the guide that was followed, corrected to match the real portal |
| `public/deployment/make-azure-ca.js` | writes the two certificate files Azure needs |
| `public/deployment/DEPLOY-ORACLE.md`, `public/deployment/oracle/` | an unused alternative (Oracle needs a card) |
| `public/backend/routes/login.js`, `public/frontend/scripts/shared/session.js` | sign-in page says "The database is not answering" when the database is down, and no longer tells the user to retype the password. `session.js` also holds earlier unrelated changes |
| `.env.azure`, `azure-ca.pem`, `azure-ca-one-line.pem` | settings and certificates for Azure. Git ignores them |

Many other files were already modified before this work started (see
`git status`); they are separate, unfinished work and were not touched.

## Warnings for whoever continues

- Always pass `--env .env.azure` to `public/deployment/load-sql.js`. Without
  it, file 1 drops the database on the laptop.
- Do not load the demo data into Azure again once real records are in it.
- Stay inside Azure's free amounts: one B1ms server, at most 32 GB, no
  auto-scale IOPS, no high availability. If the $100 credit runs out, Azure
  disables the subscription.
- Keep MySQL 8.4. Azure charges extra for 8.0 from 1 February 2027.
