# Putting Lucelyn Hardware online: everything on Oracle Cloud

The app runs on a free **Oracle Cloud server**, and the MySQL database runs on
Oracle's free **MySQL DB system** in the same private network. Nothing here
uses Vercel or Aiven. The same code still runs on a PC with `npm start`.

```
browser ──https──▶ Caddy (ports 80 and 443) ─▶ the app, npm start (port 3000)
                   └──────── Oracle server (Ubuntu) ────────┘
                                                  │  private network
                                                  ▼
                                        Oracle MySQL (hardware_db)
```

> **Status of this guide.** Written in November 2026 from Oracle's
> documentation. It has **not yet been run on a real Oracle account**, so a
> button in the Oracle Console may be named a little differently from what is
> written here. The database files were checked for things newer MySQL
> versions reject, and none were found.

## Why move

Aiven is ending its free MySQL plan. On **21 December 2026** it powers off the
remaining free MySQL services and deletes their data and backups. Oracle's
free MySQL has no public address, so Vercel cannot reach it directly. A server
inside the same Oracle network can, which is why the app moves too.

## What is different from Vercel

| On Vercel | On the Oracle server |
|---|---|
| Address `https://<project>.vercel.app` comes with it | You pick a free address (Part 4). Caddy gets the https certificate. |
| A push to GitHub updates the site | You update it with three commands (Part 10) |
| Copies of the server start and stop by themselves | One server runs all the time, like on a PC |
| Each screen asks for updates every 8 seconds | Every 3 seconds, as on a PC |
| Backups kept inside the database | Backups are files in `backups/` on the server |
| Daily jobs run by Vercel Cron | The app's own timers run them. `CRON_SECRET` is not needed. |
| Restore from a file up to 4.5 MB | No such limit |

## What you need before starting

- A debit or credit card. Oracle asks for one at sign-up to check who you are.
  The free resources in this guide are not charged.
- This project pushed to GitHub.
- About two hours.

## Part 1: the Oracle account

1. Go to [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) and
   press **Start for free**.
2. When it asks for the **Home Region**, choose **Singapore**, the nearest to
   the Philippines. **The home region cannot be changed later**, and every
   free resource must be made in it.
3. Finish the sign-up and sign in to the Oracle Cloud Console.

## Part 2: the private network

1. In the Console menu open **Networking → Virtual cloud networks**.
2. Press **Start VCN Wizard**, choose **Create VCN with Internet
   Connectivity**, and press **Start VCN Wizard**.
3. Name it `ohsicms-vcn`. Leave the address ranges as shown (VCN
   `10.0.0.0/16`, public subnet `10.0.0.0/24`, private subnet `10.0.1.0/24`).
   Press **Next**, then **Create**.
4. Open the new network, then **Security Lists**. Two were made. Add one rule
   to each with **Add Ingress Rules**:

   | Security list | Source CIDR | Protocol | Destination port | Lets in |
   |---|---|---|---|---|
   | **Security List for Private Subnet-ohsicms-vcn** | `10.0.0.0/16` | TCP | `3306` | the app server to the database |
   | **Default Security List for ohsicms-vcn** | `0.0.0.0/0` | TCP | `80,443` | browsers to the web site |

## Part 3: the database

1. In the Console menu open **Databases → HeatWave MySQL → DB Systems** and
   press **Create DB system**.
2. Choose **Always Free**.
3. **Name:** `ohsicms-db`.
4. **Administrator credentials:** username `admin` and a password of your own.
   Write both down. (`root` is not allowed as the username.)
5. **Networking:** Virtual cloud network `ohsicms-vcn`, Subnet **the private
   subnet**.
6. **Hardware:** the shape is `MySQL.Free` with 50 GB. The HeatWave cluster is
   not used by this system; you may switch **Enable HeatWave cluster** off.
7. Press **Create** and wait until the DB system says **Active** (10 to 20
   minutes).
8. Open it and note the **Private IP address** under Endpoint (it looks like
   `10.0.1.25`). The port is `3306`.

## Part 4: the server and its address

1. In the Console menu open **Compute → Instances** and press **Create
   instance**.
2. **Name:** `ohsicms-app`.
3. **Image:** press **Change image** and choose **Ubuntu**, **Canonical Ubuntu
   24.04**.
4. **Shape:** press **Change shape** and choose **VM.Standard.E2.1.Micro**. It
   is marked *Always Free-eligible*.
5. **Networking:** choose the existing network `ohsicms-vcn` and its **public
   subnet**, and keep **Automatically assign public IPv4 address** on.
6. **SSH keys:** choose **Generate a key pair for me** and press **Save private
   key**. Keep that file safe: it is the only way into the server.
7. Press **Create**. When it says **Running**, note its **Public IP address**.
8. Give the server a name people can type. At
   [duckdns.org](https://www.duckdns.org) sign in, make a subdomain (for
   example `lucelyn-hardware`), put the server's Public IP address in its
   **current ip** box and press **update ip**. Your address is now
   `lucelyn-hardware.duckdns.org`. A domain name you own works the same way:
   point its `A` record at the Public IP address.

## Part 5: get into the server and install the programs

1. On your PC, open PowerShell and connect (use your own key file and IP
   address):

   ```bash
   ssh -i "C:\Users\You\Downloads\ssh-key.key" ubuntu@YOUR_PUBLIC_IP
   ```

   Answer `yes` the first time. The prompt changes to `ubuntu@ohsicms-app`.
   Every command from here on is typed in that window.

2. Install Node.js, git and Caddy:

   ```bash
   sudo apt update
   ```

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   ```

   ```bash
   sudo apt install -y nodejs git caddy
   ```

   `node --version` should now print `v24` and some more numbers.

## Part 6: the app and its data

1. Copy the project from GitHub into a folder named `ohsicms`. On your PC,
   `git remote -v` shows your repository's address.

   ```bash
   git clone YOUR_GITHUB_REPOSITORY_ADDRESS ohsicms
   ```

   If the repository is private, GitHub asks for your user name and a
   [personal access token](https://github.com/settings/tokens) in place of a
   password.

2. Install what the app needs:

   ```bash
   cd ~/ohsicms
   ```

   ```bash
   npm install
   ```

3. Make the settings file and fill it in:

   ```bash
   cp public/deployment/oracle/oracle.env.example .env
   ```

   ```bash
   nano .env
   ```

   | Setting | Value |
   |---|---|
   | `DB_HOST` | the DB system's Private IP address from Part 3 |
   | `DB_USER`, `DB_PASSWORD` | the administrator you made in Part 3 |
   | `HARDWARE_SITE_URL` | `https://` and your address from Part 4, such as `https://lucelyn-hardware.duckdns.org` |
   | `MAIL_USER`, `MAIL_PASSWORD` | optional: the Gmail account and App Password that send first passwords and reset codes |
   | `PAYMENT_PROVIDER` | `sim`, or `paymongo` with `PAYMONGO_SECRET_KEY` |

   Leave the other lines as they are. Save with **Ctrl+O**, **Enter**, then
   leave with **Ctrl+X**.

4. Put the demo data in (to bring your real data from Aiven, do this step
   first and then follow Part 11):

   ```bash
   node public/deployment/load-sql.js public/database/1-database.sql public/database/2-stored-procedures.sql --yes
   ```

   It should say `Connected to 10.0.1.x:3306.` and `done.` for both files.

5. Try the app once:

   ```bash
   npm start
   ```

   It should say `Connected to MySQL database "hardware_db"` and
   `All 37 stored procedures are loaded`. Stop it with **Ctrl+C**.

## Part 7: keep the app running

This makes the app start when the server starts, and start again if it stops.

```bash
sudo cp public/deployment/oracle/ohsicms.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now ohsicms
```

```bash
sudo systemctl status ohsicms
```

The last command should show **active (running)**. Press **q** to leave it.

## Part 8: open the web site with https

1. Oracle's Ubuntu servers block every port except SSH. Look at the rules:

   ```bash
   sudo iptables -L INPUT -n --line-numbers
   ```

   Find the line that says **REJECT** and note its number (usually `6`). Use
   that number in the two commands below, so the new rules land above it:

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   ```

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   ```

   ```bash
   sudo netfilter-persistent save
   ```

2. Tell Caddy your address. Open the file, change
   `lucelyn-hardware.duckdns.org` to your own address, and save:

   ```bash
   nano public/deployment/oracle/Caddyfile
   ```

   ```bash
   sudo cp public/deployment/oracle/Caddyfile /etc/caddy/Caddyfile
   ```

   ```bash
   sudo systemctl restart caddy
   ```

3. On any device, open `https://` and your address. It goes to the sign-in
   page. The first visit can take up to a minute while Caddy gets the
   certificate.

## Part 9: PayMongo (optional)

In the PayMongo dashboard make a webhook pointing at
`https://YOUR_ADDRESS/api/paymongo/webhook` for `payment.paid` and
`payment.failed`. Put its secret in `.env` as `PAYMONGO_WEBHOOK_SECRET`, then
restart the app (`sudo systemctl restart ohsicms`).

## Part 10: updating the site after a push

Connect to the server (Part 5, step 1), then:

```bash
cd ~/ohsicms && git pull
```

```bash
npm install
```

```bash
sudo systemctl restart ohsicms
```

After changing `.env`, only the last command is needed.

## Part 11: bringing the data from Aiven

Do this **before 21 December 2026**.

1. In the Aiven console, power the MySQL service on if it is off, and wait
   until it says **Running**.
2. On the old site (`https://<project>.vercel.app`), sign in as the System
   Administrator. In **Backup & Recovery** press **Run Backup Now**, then
   download that backup.
3. On the new site, sign in as the System Administrator (the demo data's
   account). In **Backup & Recovery**, restore from the file you downloaded.
4. Sign in again with an account from the old site and check a few records.
5. Keep the downloaded file somewhere safe.

## Limits worth knowing

- **An idle free server may be reclaimed.** Oracle counts a free server as
  idle when, over 7 days, its CPU use (95th percentile) and its network use
  are both under 20%. A site with few visitors fits that. If the site stops
  answering, open **Compute → Instances** and press **Start**. A 2023 notice
  from Oracle said that changing the account to *Pay As You Go* keeps idle
  servers from being stopped, and free resources stay free on such an
  account; check Oracle's current wording before relying on that.
- **The database upgrades itself.** A free DB system always runs Oracle's
  newest MySQL version and is upgraded in its maintenance window. The PC runs
  MySQL 8.0. After an upgrade, sign in and try a sale.
- **Oracle keeps one day of database backups.** The app's own daily backup
  (2:00 AM, in `backups/` on the server) is the real safety net. Download one
  from **Backup & Recovery** now and then.
- **The server is small**: 1 GB of memory. That is enough for the app, since
  the database runs elsewhere.
- **"Out of host capacity"** when making the server or the database means the
  region has no free machines at that moment. Try again later.
- **The free tier has no support and no uptime promise.**

## If something goes wrong

| Symptom | Where to look |
|---|---|
| `ssh` says the key's permissions are too open | In PowerShell: `icacls "C:\path\to\ssh-key.key" /inheritance:r /grant:r "%USERNAME%:R"` |
| `load-sql.js` or `npm start` says `ETIMEDOUT` or `DATABASE CONNECTION FAILED` | The `3306` rule in Part 2 is missing or on the wrong security list, or `DB_HOST` is not the DB system's Private IP address |
| `Access denied for user` | `DB_USER` or `DB_PASSWORD` in `.env` does not match Part 3 |
| A statement fails while loading file 1 or 2 | Oracle's MySQL is newer than the PC's. Copy the message; the statement needs adjusting for that version |
| The browser cannot open the site at all | The `80,443` rule in Part 2, the two `iptables` commands in Part 8, or the DuckDNS **current ip** |
| The browser warns about the certificate | `sudo journalctl -u caddy -n 50`. The address in `/etc/caddy/Caddyfile` must match the DuckDNS name exactly |
| The site says `502 Bad Gateway` | The app is not running: `sudo systemctl status ohsicms`, then `sudo journalctl -u ohsicms -n 50` |
| Sign-in says "The database is not answering" | The DB system is stopped or was upgraded just now. Check that it says **Active** in the Console |
| Sign-in works but you are signed out at once | The site was opened with `http://`. Use the `https://` address (`COOKIE_SECURE=1` needs it) |
| Dates or "today's sales" are off by 8 hours | `HARDWARE_TIME_ZONE=Asia/Manila` is missing from `.env` |
