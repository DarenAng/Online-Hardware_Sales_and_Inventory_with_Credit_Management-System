# Putting Lucelyn Hardware online: Vercel + Aiven

The app runs on **Vercel** (the Express server becomes one Vercel Function, and
the css and browser scripts are served from Vercel's CDN). The MySQL database
runs on **Aiven**. The same code still runs on a PC with `npm start`.

```
browser ──https──▶ Vercel CDN  (css, /modules, /connections, /vendor)
                └▶ Vercel Function api/index.js ──▶ public/Back-end/server.js
                                                      │  SSL
                                                      ▼
                                                 Aiven MySQL (hardware_db)
```

## What is different online

Vercel starts and stops copies of the server as requests come in, and nothing
runs between requests. So:

| On a PC | On Vercel |
|---|---|
| Sign-ins kept by the server | Kept in the `user_sessions` table, so every copy knows them. A restart no longer signs anybody out. |
| Live updates arrive at once | Each open screen asks every **8 seconds** (`LIVE_POLL_SECONDS`), every 30 when its tab is hidden |
| Backups are files in `backups/` | Backups are kept gzipped in the `backup_files` table. **Download one now and then**: a backup kept inside the database it backs up is lost with it |
| Daily backup, archive sweep and late-payment sweep run on timers | Run once a day by Vercel Cron (`/api/cron/daily`, 2:00 AM Manila; on the free plan Vercel may run it any time in that hour) |
| Restore from an uploaded file | Same, up to 4.5 MB (Vercel's limit). A bigger file goes in with `scripts/load-sql.js` (below) |
| The clock is the PC's | The app sets Asia/Manila itself (`HARDWARE_TIME_ZONE`); Vercel does not allow `TZ` |
| QR codes lead to this PC's Wi-Fi address | QR codes lead to the Vercel address, so a phone on any network can open them |

The code that makes this work: `vercel.json`, `api/index.js`,
`scripts/vercel-build.js`, and the server tables described in
`public/database/1-RUN-FIRST-database.sql`.

## Part 1: the database on Aiven

1. Sign up at [console.aiven.io](https://console.aiven.io) and **Create service → MySQL**.
   The free plan is enough for a shop. Choose the region nearest Singapore you
   are offered: `vercel.json` runs the app in Singapore (`"regions": ["sin1"]`),
   and every page makes several trips to the database, so the two should be
   close. If you pick a region far from Singapore, change `regions` in
   `vercel.json` to the [Vercel region](https://vercel.com/docs/regions) nearest it.
2. Wait until the service says **Running**. On its **Overview** page note the
   **Host**, **Port**, **User** (`avnadmin`) and **Password**, and download the
   **CA certificate**. Save it in the project folder as `aiven-ca.pem` (git and
   Vercel ignore `*.pem` files).
3. In the project folder, make a file named `.env.aiven` (git ignores it):

   ```
   DB_HOST=mysql-xxxxxxxx-yourname.aivencloud.com
   DB_PORT=12345
   DB_USER=avnadmin
   DB_PASSWORD=the-aiven-password
   DB_NAME=hardware_db
   DB_SSL_CA_FILE=aiven-ca.pem
   ```

4. Put the data in. Pick **one** of these:

   **A. Your shop's real data** (recommended). Take a fresh backup on the PC
   (System Administrator → Backup & Recovery → Run Backup Now), then load that
   file:

   ```bash
   node scripts/load-sql.js --env .env.aiven --database hardware_db backups/hardware_db_backup_YYYY-MM-DD_HHMM.sql
   ```

   **B. The demo data**, as on a new PC:

   ```bash
   node scripts/load-sql.js --env .env.aiven public/database/1-RUN-FIRST-database.sql public/database/2-RUN-SECOND-stored-procedures.sql --yes
   ```

   (`--yes` is needed because file 1 starts with `DROP DATABASE hardware_db`.)

5. Optional but worth it: run the app on your PC against Aiven before deploying.

   ```bash
   node --env-file=.env.aiven public/Back-end/server.js
   ```

   It should say `Connected to MySQL database "hardware_db"` and
   `All 36 stored procedures are loaded`. Sign in at http://localhost:3000.
   The first start also creates the six server tables.

## Part 2: the app on Vercel

1. Push the project to GitHub (it already has `origin` set).
2. At [vercel.com/new](https://vercel.com/new), import the repository. Leave
   **Framework Preset**, **Build** and **Output** settings as Vercel shows them:
   `vercel.json` sets them.
3. Before pressing Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | from Aiven |
   | `DB_NAME` | `hardware_db` |
   | `DB_SSL_CA` | the **whole text** of `aiven-ca.pem`, from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----` |
   | `CRON_SECRET` | any long random text, such as the output of `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `PAYMENT_PROVIDER` | `paymongo` (with `PAYMONGO_SECRET_KEY` = your `sk_test_...` key), or `sim` for the offline simulator |
   | `MAIL_USER`, `MAIL_PASSWORD` | optional: the Gmail account and App Password that send first passwords and reset codes. Without them the password is shown on screen. |
   | `NODEJS_HELPERS` | `0`, so Express reads request bodies itself (the PayMongo webhook checks the exact bytes it was sent) |

   Everything else in `.env.example` is optional and has a sensible default.
   Do **not** upload your `.env`: it points at the MySQL on your PC.
4. Press **Deploy**. When it finishes, open `https://<your-project>.vercel.app`.
   It goes to the sign-in page.
5. Check the daily job: Vercel → your project → **Settings → Cron Jobs** lists
   `/api/cron/daily`. Press **Run** once; the function log shows
   `Daily job: {"penalties":"ok","archives":"ok","backup":"ok",...}` and
   Backup & Recovery shows a new automatic backup.
6. PayMongo (optional): in the PayMongo dashboard make a webhook pointing at
   `https://<your-project>.vercel.app/api/paymongo/webhook` for `payment.paid`
   and `payment.failed`, and add its secret as `PAYMONGO_WEBHOOK_SECRET`. Without
   it the till still asks PayMongo every 3 seconds.

After changing an environment variable, redeploy (Deployments → ⋯ → Redeploy):
a running deployment keeps the values it started with.

## Limits worth knowing

- **Vercel Hobby (free)** allows about a million function requests a month.
  Every open screen asks for updates about 450 times an hour, so five screens
  open 10 hours a day come to roughly 700,000 a month before any other clicks.
  If you get close, raise `LIVE_POLL_SECONDS` (for example to 15).
- **Aiven's free plan** has few connections and modest storage. Each copy of the
  server keeps at most 3 connections (`DB_CONNECTION_LIMIT`). A stored backup
  of the demo data is about 50 KB gzipped (250 KB of SQL); 30 automatic plus
  20 manual fit easily. Check your Aiven plan's own backup and power-off rules in its console.
- **The daily jobs run once a day** on Vercel's free plan. The late-payment
  sweep ran hourly on a PC; online it charges overdue sales at the daily run.
- **The first request after a quiet spell is slower** (a second or two): Vercel
  starts a copy of the server, and it checks the database's columns before answering.

## If something goes wrong

| Symptom | Where to look |
|---|---|
| Every page says the session ended, or sign-in fails with a 500 | Vercel → Logs. `DATABASE CONNECTION FAILED` means a wrong `DB_*` value or `DB_SSL_CA`. `self-signed certificate` means `DB_SSL_CA` is missing or cut short. |
| "This database has N of 36 stored procedures" | Load file 2: `node scripts/load-sql.js --env .env.aiven public/database/2-RUN-SECOND-stored-procedures.sql` |
| Dates or "today's sales" are off by 8 hours | `HARDWARE_TIME_ZONE` was changed; remove it, or set `Asia/Manila` |
| The daily job shows 401 in the logs | `CRON_SECRET` was added after the deploy: redeploy |
| `/Back-end/...` or `/database/...` opens in a browser | It should not: those return 404. If they open, the Output Directory was changed from `vercel-static` in the Vercel settings. |
