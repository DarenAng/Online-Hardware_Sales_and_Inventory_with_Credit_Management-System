# Putting Lucelyn Hardware online: Vercel + Azure for Students

The app stays on **Vercel**, exactly as in `DEPLOY-VERCEL-AIVEN.md`. Only the
MySQL database moves: from Aiven to **Azure Database for MySQL**, paid for by
the free **Azure for Students** offer. No credit card is needed, only a school
email address.

```
browser ──https──▶ Vercel (the app, unchanged)
                      │  SSL
                      ▼
            Azure Database for MySQL (hardware_db)
```

> **Status of this guide.** Written in November 2026 from Microsoft's
> documentation. Parts 1 to 5 were then followed on a real Azure for Students
> account on 13 November 2026 and corrected to match the portal: the demo data
> loaded into MySQL 8.4 without an error, and a sign-in and a cash sale worked
> from the PC. Part 6 (Vercel) had not been done when this was written.

## Why move

Aiven is ending its free MySQL plan. On **21 December 2026** it powers off the
remaining free MySQL services and deletes their data and backups.

## What Azure for Students gives

| | |
|---|---|
| Credit | $100, valid one year, renewable each year you are a student |
| Free MySQL for 12 months | 750 hours a month of a **Burstable B1ms** server (one server running all month), **32 GB** storage and 32 GB backup storage |
| Card | Not needed |

**If the $100 credit is used up, Azure disables the subscription.** Create
only what this guide lists, so the server stays inside the free amounts.

## Part 1: the Azure for Students account

1. Go to [azure.microsoft.com/free/students](https://azure.microsoft.com/en-us/free/students)
   and press **Start free**.
2. Sign in with a Microsoft account (or make one), then verify with your
   **school email address**.
3. Open the Azure portal at [portal.azure.com](https://portal.azure.com).

## Part 2: the MySQL server

1. In the portal's search box type **Azure Database for MySQL flexible
   servers**, open it, and press **Create**. Under **Flexible server** press
   **Advanced Create**.
2. On the **Basics** tab:

   | Setting | Value |
   |---|---|
   | Subscription | Azure for Students |
   | Resource group | **Create new**: `ohsicms` |
   | Server name | a name of your own, such as `ohsicms-db-yourname`. Lowercase letters, numbers and `-` only |
   | Region | One your subscription allows (see *The region rule* below). `vercel.json` runs the app in Hong Kong (`"regions": ["hkg1"]`) to sit next to an **East Asia** database. For another region, change `regions` to the [Vercel region](https://vercel.com/docs/regions) nearest it |
   | MySQL version | **8.4**. Not 8.0: Azure charges extra for 8.0 from 1 February 2027 |
   | Workload type | **Dev/Test** |
   | Authentication method | **MySQL authentication only** |
   | Admin username | a name of your own, such as `ohsicmsadmin`. Azure refuses `admin`, `administrator`, `root`, `guest`, `sa`, `public` and `azure_superuser` |
   | Password | a long one of your own. Write it down |

3. Still on Basics, press **Configure server** under *Compute + storage* and
   set:

   | Setting | Value |
   |---|---|
   | Compute tier | **Burstable** |
   | Compute size | **Standard_B1ms** |
   | Storage size | **32 GiB** or less |
   | IOPS | **Pre-provisioned**, left at the number shown. Not *Auto scale IOPS* |
   | Storage auto-growth | **off** |
   | High availability | **off** |
   | Backup retention | 7 days |
   | Geo-redundant backup | **off** |

   Press **Save**.

4. On the **Networking** tab:
   - Connectivity method: **Public access**. This cannot be changed later.
   - Firewall rules: Vercel has no fixed address, so every address must be let
     in. Press **Add 0.0.0.0 - 255.255.255.255**. Azure warns that any
     computer on the internet can then reach the server; press **Continue**.
     The server is guarded by the password and by the forced SSL connection,
     which is why the password must be a long one.
5. Press **Review + create**. The cost box marks the compute "Free upto 750
   hours" and the storage "Free upto 32 GB". The total it prints (about USD 24
   a month) is the normal price before the free amounts. Press **Create** and
   wait about five minutes.
6. Press **Go to resource**. On the **Overview** page note the **Server name**
   (it ends in `.mysql.database.azure.com`).

### The region rule

An Azure for Students subscription only allows a few regions. If **Create**
answers "The template deployment failed because of policy violation", the
region is not one of them. To see the allowed ones: search **Policy** in the
portal, open **Authoring → Assignments**, press **⋯** on *Allowed resource
deployment regions*, choose **Edit assignment**, open the **Parameters** tab
and open **Allowed locations**. The ticked regions are yours. Close the page
without saving. Then go back to **Basics**, change **Region**, and press
**Review + create** again; the other settings stay as you set them.

On the account this guide was first used with, the allowed regions were
Australia East, East Asia, India South Central, Japan East and Korea Central.
Southeast Asia was refused, and East Asia (Hong Kong) was chosen.

## Part 3: the settings file and the certificates

1. Azure only accepts SSL connections. Make the two certificate files it needs
   (they come from Node.js itself; nothing is downloaded):

   ```bash
   node public/deployment/make-azure-ca.js
   ```

   This writes `azure-ca.pem` and `azure-ca-one-line.pem` in the project
   folder. Git and Vercel ignore `*.pem` files.

2. In the project folder, make a file named `.env.azure` (git ignores it):

   ```
   DB_HOST=ohsicms-db-yourname.mysql.database.azure.com
   DB_PORT=3306
   DB_USER=ohsicmsadmin
   DB_PASSWORD=the-azure-password
   DB_NAME=hardware_db
   DB_SSL_CA_FILE=azure-ca.pem
   ```

## Part 4: put the data in

Pick **one** of these.

**A. The data from the old site.** Do this before 21 December 2026.

1. In the Aiven console, power the MySQL service on if it is off, and wait
   until it says **Running**.
2. On the site, sign in as the System Administrator. In **Backup & Recovery**
   press **Run Backup Now**, then download that backup into the project's
   `backups` folder.
3. Load it into Azure:

   ```bash
   node public/deployment/load-sql.js --env .env.azure --database hardware_db backups/hardware_db_backup_YYYY-MM-DD_HHMM.sql
   ```

**B. The demo data**, as on a new PC:

```bash
node public/deployment/load-sql.js --env .env.azure public/database/1-database.sql public/database/2-stored-procedures.sql --yes
```

(`--yes` is needed because file 1 starts with `DROP DATABASE hardware_db`.)

Either way it should say `Connected to ...mysql.database.azure.com:3306 over SSL.`
and `done.`

## Part 5: try it on the PC first

```bash
node --env-file=.env.azure public/backend/server.js
```

It should say `Connected to MySQL database "hardware_db"` and
`All 37 stored procedures are loaded`. Sign in at http://localhost:3000 and
make a test sale. Stop it with **Ctrl+C**.

## Part 6: point Vercel at Azure

1. In Vercel open the project, then **Settings → Environment Variables**, and
   change these five:

   | Name | New value |
   |---|---|
   | `DB_HOST` | the Server name from Part 2 |
   | `DB_PORT` | `3306` |
   | `DB_USER` | the admin username from Part 2 |
   | `DB_PASSWORD` | its password |
   | `DB_SSL_CA` | the whole content of `azure-ca-one-line.pem` (one long line) |

   `DB_NAME` stays `hardware_db`. Leave every other variable as it is.
2. Redeploy: **Deployments → ⋯ → Redeploy**. A running deployment keeps the
   values it started with. (Pushing a commit also makes a new deployment.)
3. Open the site and sign in.
4. With the demo data, sign in to **each of the five demo accounts** straight
   away. The system makes each one choose a new password on its first
   sign-in, and until then the passwords are the ones written in
   `public/database/1-database.sql`.

If the project is not on Vercel yet, follow Part 2 of `DEPLOY-VERCEL-AIVEN.md`
with the values above.

## Limits worth knowing

- **Stay inside the free amounts.** One B1ms server, 32 GB of storage, the
  options in Part 2 left off. A second server, a bigger size, *Auto scale
  IOPS* or high availability are paid from the $100 credit. Look at **Cost
  Management** in the portal now and then; it should stay at or near zero.
- **The free MySQL lasts 12 months.** After that the server is paid from the
  credit. Renew the student offer each year for a new $100, and check the
  cost page when the 12 months end.
- **Azure does not power the server off when the site is quiet**, unlike
  Aiven's free plan.
- **The database is MySQL 8.4; the PC runs 8.0.** The database files were
  checked for things 8.4 rejects and none were found. After loading, try a
  sale, a credit payment and a report once.
- **The firewall lets in every address**, because Vercel needs that. Never
  share the password, and never put `.env.azure` in git.

## If something goes wrong

| Symptom | Where to look |
|---|---|
| `Connections using insecure transport are prohibited` | `DB_SSL_CA_FILE` (on the PC) or `DB_SSL_CA` (on Vercel) is missing |
| `self-signed certificate in certificate chain` or `unable to get local issuer certificate` | `DB_SSL_CA` in Vercel is cut short. Paste the whole of `azure-ca-one-line.pem` again |
| `ETIMEDOUT`, or the sign-in page says "The database is not answering" | The firewall rule in Part 2 is missing, or the server is stopped. In the portal open the server: **Networking**, and **Overview → Start** |
| `Access denied for user` | `DB_USER` or `DB_PASSWORD` does not match Part 2. The user name is written alone, without `@servername` |
| A statement fails while loading file 1, file 2 or a backup | Something MySQL 8.4 does not accept. Copy the message; the statement needs adjusting |
| "This database has N of 37 stored procedures" | Load file 2: `node public/deployment/load-sql.js --env .env.azure public/database/2-stored-procedures.sql` |
| The cost page shows a charge | Open the server → **Compute + storage** and set it back to the values in Part 2 |
