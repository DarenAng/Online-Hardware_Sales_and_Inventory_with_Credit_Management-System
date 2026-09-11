# Online Hardware Sales and Inventory with Credit Management

A point of sale, inventory, and customer credit system. Node with Express on the
server, plain HTML, CSS, Bootstrap 5 and JavaScript on the client, MySQL 8 for
the data.

## Setup on a new computer

You need MySQL 8.0 or newer and Node 18 or newer installed first.

### 1. Copy the project folder

Copy the whole folder. You do not need `node_modules`, step 2 rebuilds it.
Bootstrap is already inside the folder under `public/vendor/`, so nothing is
downloaded from the internet while the system runs.

### 2. Install the packages

Open a terminal in the project folder and run:

```
npm install
```

### 3. Create the database

Open MySQL Workbench, or a terminal with the `mysql` command, and run these two
files in order:

```
public/database/1-RUN-FIRST-database.sql
public/database/2-RUN-SECOND-stored-procedures.sql
```

The names give the order. `1-RUN-FIRST-database.sql` drops and rebuilds
`hardware_db`, creates 23 tables and 2 views, and loads the demo data.
`2-RUN-SECOND-stored-procedures.sql` loads the 27 stored procedures; the tables
have to exist before it will run.

Run them in MySQL Workbench or the `mysql` command line. Those two honour the
`DELIMITER` keyword. Other clients sometimes do not, and the procedures fail to
load.

From a terminal it looks like this:

```
mysql -u root -p < public/database/1-RUN-FIRST-database.sql
mysql -u root -p < public/database/2-RUN-SECOND-stored-procedures.sql
```

That is the whole of it. There is no third file and no upgrade step.

### Already have a `hardware_db` with real data in it?

Do not run file 1; its first statement is `DROP DATABASE`, and everything in
there goes. Take a backup first — the System Administrator's **Backup &
Recovery** screen writes one into `backups/` — then run file 1 and restore what
you need from the backup.

File 2 is the safe one. It only drops and recreates procedures and touches no
table and no row, so it can be re-run on its own at any time. **Re-run it** if
your database was created before `staff.middle_name` existed: the server
renames the column for you at startup, but the stored procedures still expect
the old name until file 2 is loaded again.

There is one automatic upgrade, and it happens on `npm start`: `staff`'s old
`middle_initial VARCHAR(5)` column is renamed to `middle_name VARCHAR(100)` and
`full_name` is rebuilt around it. The letters already in there are kept and are
still valid middle names of one letter, so nothing is lost and nothing has to
be retyped — fill in the whole name the next time you open each record. The
server says so on the console when it does it, and does nothing at all once the
column is already `middle_name`.

Earlier versions of the project shipped `upgrade.sql` through `upgrade_v8.sql`
and `fix_patch.sql` for stepping an existing database forward one version at a
time. Every change they made is now inside `1-RUN-FIRST-database.sql`, so they
did nothing on a machine that ran the schema fresh. They have been removed; git
history still has them.

### 4. Point the server at your MySQL

Open `public/javascript/server.js` and edit the SETUP block at the top:

```js
const DB_HOST = "localhost";
const DB_USER = "root";
const DB_PASSWORD = "your-mysql-password";
const DB_NAME = "hardware_db";
const port = 3000;
```

`DB_PASSWORD` is the MySQL root password on the new machine.

### 5. Point the server at a mail account (optional)

The system sends one kind of email: the first password for an account somebody
has just been given. It works without this step — the password is shown once on
the administrator's screen instead, to be handed over — so leave it until the
rest is running.

Open `public/javascript/mailer.js` and edit the SETUP block at the top:

```js
const MAIL_ENABLED = false;
const MAIL_HOST = "smtp.gmail.com";
const MAIL_PORT = 465;
const MAIL_SECURE = true;          // true on 465, false on 587
const MAIL_USER = "";              // the full address, e.g. shop@gmail.com
const MAIL_PASSWORD = readPasswordFile();   // see WHERE THE PASSWORD GOES, above
```

Set `MAIL_ENABLED` to `true` and fill in the address. The password does not go
in this file: create `public/javascript/mail-password.txt` next to it, holding
the password on one line and nothing else. That file is in `.gitignore`, so it
stays on the machine and never reaches GitHub; every computer this is set up on
makes its own. With no such file, mail is simply off and the fallback is used.

**For a Gmail account,** the password in that file is not the password you sign
in to Gmail with — Google refuses those over SMTP. Turn on 2-Step Verification
on the account, make an App Password (16 letters) at
`myaccount.google.com/apppasswords`, and put that in the file. Leave the host
and port as they are.

**For anything else,** port 465 is TLS from the first byte, so `MAIL_SECURE`
stays `true`; port 587 starts in the clear and is upgraded with STARTTLS, so set
it to `false`. Port 25 is not offered: it is unencrypted, and this connection
carries a password.

There is no package to install. `mailer.js` speaks SMTP over Node's own `tls`,
for the same reason passwords are hashed with Node's own scrypt rather than with
bcrypt off npm: `npm install` should fetch as little as possible on a machine
this is being set up on. Check it without sending anything real:

```
node tests/mailer.js
```

`mailer.js` and `mail-password.txt` sit under `public/`, so — like `server.js`
— the server refuses to serve either of them to a browser.

### 6. Start the server

```
npm start
```

Open http://localhost:3000 in a browser.

On startup you should see three lines:

```
Connected to MySQL database "hardware_db" on localhost.
All 27 stored procedures are loaded.
Server running at http://localhost:3000
```

A warning about missing procedures means step 3 did not finish. Run
`2-RUN-SECOND-stored-procedures.sql` again in Workbench or the `mysql` CLI.

## Demo logins

| Role                 | Email                   | Password     |
|----------------------|-------------------------|--------------|
| System Administrator | admin@hardware.com      | admin123     |
| Manager              | manager@hardware.com    | manager123   |
| Inventory Clerk      | clerk@hardware.com      | clerk123     |
| Cashier              | cashier@hardware.com    | cashier123   |
| Delivery Personnel   | delivery@hardware.com   | delivery123  |

Only the admin account skips the first login password change. The other five
land on `change-password.html` and pick a new password of 8 characters or more.

## Getting around

The menu on the left stays put while a page scrolls, and so does the bar across
the top, so the way out of a screen is always where you left it.

Navigation is two levels, each with one job. The menu on the left holds the
modules and is the same list all day. The strip across the top holds the
screens inside whichever module is open, and it changes as you move; on a
module that has only one screen it is not there at all. The strip is built
from the menu itself, so a screen a role cannot open never gets a tab.

The bar itself is separated from the page three ways: a tinted band along its
top edge, a ground a shade off the white of the cards below it, and a soft
shadow that puts it in front of the page rather than in it. It used to be the
same white as every card under it, which on a wide monitor made the one strip
holding the page title, the alert bell and the way out read as the top of the
first card — and people went looking for the account menu in the menu. All
three marks are drawn rather than added, so the bar is the same height it
always was and the tab strip still sits flush under it.

On a narrow screen the menu slides in over the page instead of sitting beside
it. Press the button at the top left to open it; the shaded page behind it,
the Escape key, or choosing anything from the menu closes it again.

Colour means the same thing everywhere:

| Colour  | Meaning | Where you see it |
|---------|---------|------------------|
| Orange  | Press this | Primary buttons, the menu item you are on, the tab you are reading, the brand corner |
| Green   | This is fine, nothing to do | Paid, Delivered, In Stock, saved |
| Amber   | Look at this, nothing is broken yet | Unread alerts, low stock, partial payments, delayed deliveries, counts |
| Crimson | This stops something, or money is owed | Delete, deactivate, restore over everything, Unpaid, Failed |

Anything that is none of those four is grey, so the coloured things stay worth
noticing. Colour is never the only carrier: every badge, button and banner says
its own word too, so the system reads the same to somebody who cannot tell the
orange from the crimson.

Actions and states are deliberately different colours. One colour used to do
both jobs, which reads well on a button and badly in a table: a column of
badges and the button in the corner competed for the same glance. Now a badge
is never the colour of the thing you press on that screen.

The orange is the shop's own, taken from the sign over the door. The amber did
not move when the system was repainted — it was already a safety yellow rather
than a decorative gold, and it already means on a low-stock row what it means
on a hard hat. The crimson is kept twice as dark as the orange on purpose,
because two warm colours a hue apart is how somebody deletes a cashier account
on a Friday afternoon while meaning to save one.

Every one of those pairs was measured rather than eyeballed: text clears 4.5:1
against its own background and every edge clears 3:1. The whole palette is the
`:root` block at the top of `css/general-ui.css`, and changing the system's
colours means changing those values and nothing else.

## On a phone

Every screen works on a phone, and the tables are the reason that took work.
A six-column table on a 380px screen either shrinks until nothing can be read
or scrolls sideways, which hides the figure you opened the page for.

So below 640px a table stops being a table. Each row becomes a card: the name
of the record on top, then one line per value with the name of its column
beside it, then whatever you can do to that record as a full-width button at
the bottom. Nothing has to be repeated in the markup for this — the column
names are read off the table's own headings by `labelTableCells()` in
`javascript/modules/shared/tables.js` and stamped onto every cell as it is
filled in, so the thirty-odd functions that draw these tables did not change.

The rest of it:

- Everything you press is at least 44px, and the delivery driver's status
  buttons and the cashier's quantity buttons are larger still.
- Fields are 16px, which is the size below which iOS Safari zooms the whole
  page in when a field takes focus.
- Popups arrive as sheets from the bottom of the screen and scroll inside
  themselves, rather than growing past the top of the window.
- Nothing that matters sits behind a notch or a home bar.

## Your own account

Every role has an account menu in the top right corner of its dashboard — the
only way out of the system, so it is in one place rather than two. It opens on
a click and offers two things: **View my credentials**, and **Log out**.

View my credentials opens a card with three tabs, and everything about your own
account is behind them:

- **Credentials** — everything the system holds about you.
- **Edit Details** — first name, middle name, last name, phone and the email
  you sign in with. Your role is not editable here; only the system
  administrator moves people between roles.
- **Password** — your current password is asked for first, so an unattended
  screen cannot be used to lock you out of your own account.

The menu used to list all three as items of their own. All three opened the
same card, which then showed its tabs anyway, so the menu was offering three
doors into one room. It offers the door and the room does the rest.

## The first password, and who is allowed to know it

**Nobody types the first password**, and **the account is not created until
somebody has read it back.** Creating an account is two steps:

1. Fill the form in — a name, a role, a phone number, an email address — and
   press **Review & Create**. Nothing is created. The server works the whole
   account out, makes the password, and shows you the lot: the name as the
   directory will spell it, the middle name, the role, the number in +63 form,
   the address the password is about to go to, and the password itself.
2. Press **Create the account**. Now it exists, and the password is sent.

**Go back and edit** creates nothing, because the first step wrote nothing.

That middle card is there for one thing above all: the email address. It is the
one field on the form that cannot be corrected afterwards, because by the time
you notice, the password has already been sent to whatever was typed.

There used to be a **Temporary Password** box on that form, and an administrator
typed one into it for somebody else. Every one of those went the way they all
go: `Cashier123`, then `Cashier124`, then the same one for everybody because it
is easier to say down a corridor. It was also typed on a screen in a shop, said
out loud, and known to two people for as long as the account lasted. A password
one person invents for another is not that person's password.

What the generated one looks like, and why:

- **Fourteen characters** drawn from `crypto`'s random bytes, not
  `Math.random`. That is about 81 bits, for a secret that only has to survive
  until its owner's first sign-in.
- **No character whose identity depends on the font.** No `O` or `0`, no `I`,
  `l` or `1`, no `B` or `8`, no `S` or `5`, no `Z` or `2`. It has to survive
  being read off a phone and typed at a counter.
- **Only punctuation that sits in the same place on every keyboard.** `@ # ~ \ |`
  move between layouts, so they are left out; a password that cannot be typed is
  a support call.
- **It buys exactly one sign-in.** A new account already has
  `must_change_password` set, so the system asks for a password of the user's own
  choosing the first time they sign in and the sent one stops working the moment
  they choose.

### What is confirmed is what is created

The second request carries a draft id and nothing else. Every field — the name,
the role, the email, the password — is read back from the server's own memory,
not from the browser.

The shortcut would be to send the details and the password down, show them, and
send them all back up on confirmation. That makes the review a piece of theatre:
whatever comes back up is what gets created, so the thing read on screen and the
thing written to the database are related only by the browser's good manners. A
confirmation step is worth having exactly because what was read is what happens.

A draft is good for one confirmation and expires after ten minutes. Confirming
twice does not make two accounts — the second time says the review has expired —
which is what stops a double-clicked button or a retried request on a slow shop
network from creating a duplicate.

### If the mail cannot go

The account is still created, and the password comes back to the administrator's
screen once, in a card that stays until it is dismissed and says why it is there
rather than in an inbox — mail is not set up on this server, or the mail server
refused the message and here is what it said. It is read out and handed over.

That path exists because the alternative is worse: a shop whose internet is
down would otherwise be a shop that cannot take on a cashier. It is the fallback
and not the plan, which is why the card says what to fix.

### What the letter says, and what it does not

The mail names the shop, the address to sign in with, the password, and the fact
that the system will ask for a new one immediately. It carries **no link and no
web address**, on purpose: a mail with a password and a link in it is the shape
of every phishing message ever sent, and teaching staff that such a mail is
normal is worse than making them ask a colleague for the address once. It also
says, in as many words, that nobody will ever ask them for their password.

### It is never written down where it can be read back

The audit trail records that an account was created, by whom, from which
machine, and whether the password was emailed. It never records the password
itself. The database stores only a scrypt hash. `tests/smoke.js` checks the
trail for the generated password and fails if it finds it.

**Reset Password** on an existing account still asks an administrator to type
one. It is the same server-side machinery now, so moving it over is a small
change, but it has not been made.

## Alerts

The bell in the top right corner holds every alert for your role: low stock,
out of stock, damage and refund reports, new purchase orders, and deliveries
that have just been booked. Unread ones are marked and carry a yellow edge.

Every alert says three things, in the panel and on the popup card alike: what
happened, **who** raised it, and **when** — as a date and time plus how long
ago that was, so you can tell this morning's problem from last month's. An
alert nobody caused, such as one the system raised on its own, says "System".

New alerts also appear as cards in the bottom right corner of the screen.
Clicking one opens the full list. They step aside on their own after a few
seconds; the bell keeps them.

## Phone numbers

**One spelling, and it is `+63` followed by ten digits.**

The box used to be plain text, so it took anything: letters, spaces, brackets,
`n/a`, and the same number written as `09171234567`, `+639171234567`,
`639171234567` and `0917 123 4567` by four different people on four different
afternoons. Four spellings of one number is a column that cannot be searched,
cannot be compared, and cannot be dialled from without being read by a human
first.

So the country code is not typed at all. It is printed beside the box as fixed
furniture, and what is typed is the ten national digits:

```
 +63 | 9171234567
```

Everything that is not a digit is dropped as the keys are pressed, rather than
complained about after the form is submitted — a rule that refuses a keystroke
teaches the rule in the moment, and a rule that refuses the form at the end
teaches nothing and loses the other nine fields. Paste any of the four spellings
above and the box keeps the ten digits that matter. The trunk `0` and the `+63`
are the same thing and never both appear.

An incomplete number turns the box amber while it is being filled in, and says
nothing at all while it is empty, because the number is optional.

The same rule is enforced again in `server.js`, because a check that only exists
in a browser is a check anybody can skip with `curl`. A number is stored as
`+639171234567` and shown as `+63 917 123 4567`.

Numbers already in the database from before this rule are rewritten to `+63`
form on the next `npm start`. Anything that does not reduce to a usable number
is cleared rather than half-converted, and the server says how many — a phone
column with `n/a` in it is a column somebody will eventually try to dial.

## Staff names and the middle name

Two people may share a first and a last name. The middle name is what tells them
apart, and it is optional, so a person with none on file is not a problem.

**The whole middle name is stored, and only its first letter is shown.** Those
are two different jobs and it is worth being clear about which is which:

- The *name* is what settles which of the two Juan Cruzes a record belongs to
  when somebody is checking it against a payslip or an ID. So `staff.middle_name`
  holds the whole thing, at the length a real middle name runs to. It is on the
  person's record for anybody who opens it.
- The *initial* is what a reader needs at a glance, so that is what is printed.
  `Juan D. Cruz`, everywhere a staff name appears: the directory, the account
  chip in the corner, the receipt, the audit trail and every report. Never first
  and last alone — that is the spelling that cannot tell two people apart.

The shortening happens in exactly one place, the generated `full_name` column in
the `staff` table, so there is one definition of a staff name for the whole
system and no screen can spell it differently.

The column used to be `middle_initial VARCHAR(5)` and held one letter, because
one letter was all any screen printed. That is the wrong way round: a stored
"S" cannot tell two people apart either. A machine already running the old
schema is upgraded on the next `npm start` — see *Already have a `hardware_db`*
above.

An email address is a different matter. It is the username, MySQL enforces it as
unique, and two accounts cannot share one. If the email is already taken the
create screen says so in plain words and asks for a different one.

## Backup and recovery

The whole system is written to one `.sql` file: every table, every row, both
views and all the stored procedures. A backup taken here opens and runs in MySQL
Workbench, which is what makes it a real backup rather than an export only this
application understands.

There are two kinds, and they are told apart by their name.

### The automatic one, every sixty seconds

The server backs the whole database up **once a minute**, on its own, with
nobody pressing anything. The most that can be lost is the last minute of
trading. The **Backup & Recovery** screen says so at the top, from the server
rather than from a sentence written into the page — a screen that claims a
backup is being taken every minute because its own HTML says so is worse than a
screen that says nothing.

**Old ones are overwritten.** Sixty seconds is 1,440 complete `.sql` files a
day. At even a megabyte each that is a gigabyte and a half a day into a folder
that never stops growing, so within a week the backup feature is the reason the
disk is full — and a full disk is how the *next* backup fails, quietly, at the
moment it matters. So the automatic ones rotate: sixty exist at a time, and
writing the newest deletes the oldest. The folder settles at a fixed size on the
first hour and stays there, covering the last hour minute by minute.

It is sixty files rather than one file rewritten in place on purpose. A dump
takes a moment to write; a crash, a full disk or a killed process halfway
through leaves a truncated file, and if that file is the only one there is, the
system has no backup at all — and it had one a minute ago. Sixty files is the
same idea with the last fifty-nine still standing.

Nothing is written to the audit trail for a successful automatic backup. An
entry a minute is 1,440 entries a day, and the trail is where somebody looks to
find out who deactivated an account; burying that under a wall of identical
backup lines makes the trail unreadable. A *failure* is recorded, once, and said
on the screen in plain words with what the server actually reported — because a
backup that has quietly stopped working looks exactly like one that is working,
right up until the afternoon somebody needs it.

The three settings are three lines near the top of the backup section in
`server.js`:

```js
const AUTO_BACKUP_ENABLED = true;
const AUTO_BACKUP_MS = 60 * 1000;   // every sixty seconds
const AUTO_KEEP = 60;               // the last hour, minute by minute
```

A restore and the timer never overlap. A restore drops and rebuilds every table
in turn, and for the seconds that takes the database is neither the old contents
nor the new ones; a backup taken then would be a dump of a half-restored
database, indistinguishable from a good one and useless as the thing you reach
for next. So the timer stands down while a restore is running.

### The one you take yourself

**Run Backup Now** writes a file named `hardware_db_backup_...`. Those are
decisions — taken before a restore, before a schema change, at the end of a day
— and they are **never rotated away**. Nothing automatic can delete something an
administrator chose to keep.

The list shows both kinds with a **Kind** column saying which is which, because
it decides how long the file will be there. Each one can be downloaded,
restored, or deleted from the drawer that opens when you click its row.
Restoring replaces everything currently in the system, so the screen asks first.

## "Nothing can be saved" — the half-installed database

This one is worth reading before it happens to you, because it has happened
already and the symptom points at the wrong thing.

**Every write in this system goes through a stored procedure.** So a database
that has the tables but not the procedures reads perfectly and cannot be
written to at all. Every form answers with its own failure — *Unable to create
the account*, *Unable to complete the sale* — and every one of those names the
wrong cause. The form is fine.

It happens for one ordinary reason: **`1-RUN-FIRST-database.sql` was run and
`2-RUN-SECOND-stored-procedures.sql` was not.** File 1 rebuilds the tables and
the demo data. The procedures only exist because of file 2. Anybody resetting
their database has done exactly half the job at that point, and the missing half
is invisible.

Three things now make that state announce itself:

- **The server says so at startup, in a box you cannot miss** — not the single
  warning line it used to print, which scrolled off the top of the terminal
  twenty requests before anybody went looking.
- **Writes are refused with the actual fix.** A `503` naming
  `2-RUN-SECOND-stored-procedures.sql`, instead of each form blaming itself.
  Reading still works, so the screens stay usable, and signing in still works,
  because locking somebody out of the screen that explains the problem is the
  wrong way round. The **Backup & Recovery** screen leads with it in red.
- **The rolling backup stops deleting things.** See below — this is the part
  that could have cost real data.

Run file 2 and **reload the page — no restart needed.** The server re-checks
whenever the count is short, so writes start working again within seconds. It
touches no table and no row.

### Why the rolling backup stands down

This is the flaw that mattered, and it is worth being blunt about it.

When the procedures went missing, the automatic backup did exactly what it was
told: it took a faithful backup of a database that could not be written to, once
a minute, and each one rotated an older file out. Sixteen went into the folder
before anybody noticed. At the steady state of 60 files, **one hour of that would
have rotated out every last backup that still had the procedures in it** — sixty
flawless copies of a broken database and no way back.

A rolling window is only safe if what it is rolling over is known good. So the
procedure count is checked before anything is deleted:

- the backup is still **written** — the rows are real and worth keeping;
- nothing is **deleted** while the count is short.

The folder grows for as long as the fault lasts, which is a cost you can recover
with a broom. The other way round cannot be recovered at all. The screen says
when rotation is standing down, and the server logs it once — a folder quietly
growing past its cap is otherwise something nobody learns about until the disk
is full. Rotation resumes on its own on the next tick after the procedures come
back, and the folder settles to its cap again.

### A restore that succeeds and still leaves you stuck

A backup taken during that fault is a valid file: every table, every row,
restores without an error. It just has no procedures in it — and, having none,
it carries no `DROP PROCEDURE` lines either, so restoring one **onto a healthy
database is harmless**. The procedures already there are left alone.

The case that bites is restoring one onto a database that has no procedures
either. Everything reports success, every row arrives, and the system still
cannot save anything.

So a restore counts the procedures **afterwards** and says so in the same
sentence that reports the success — after rather than before, because the honest
test is not what the file appeared to contain, it is what the database ended up
with.

## Tables that wait to be asked

Every table in the system starts closed. It shows a search box, whatever
filters it offers, and a **Load Data** button, and it queries the database when
somebody presses one of them and not before.

This is not a loading trick. Five dashboards each fetching four or five tables
on open is twenty queries fired for the one screen a person actually wanted,
and the person who opened the page to look up a single customer waited for all
of them.

### The staff directory asks twice as little

On most screens, picking a filter on an empty table also fills it: somebody
reaching for a dropdown on an empty table is usually asking to see the thing
they just narrowed to, and making them press **Load Data** afterwards is a
second step for no reason.

The **Staff Directory** is the exception, and takes the other answer. There are
exactly two ways to make it read anything:

- **Load Data**, the button, which says what it does.
- **the search box** — typing a name is asking for that name.

Its three filters — account state, signed in, role — narrow what has already
arrived and fetch nothing at all on a closed table. The values are remembered
and applied to the first load when one is asked for. A filter that is set also
takes its own column off the grid — pick **Cashier** and every row would say
Cashier in the Role column, so the column goes until the filter is cleared.
The audit trail's action-type filter does the same. **List Users** in the menu
opens the screen without reading anything, and so does creating an account:
the new row does not cause the directory to be fetched, it is only refreshed if
somebody already had it open.

It is the one screen where the filters are also how somebody sets up a query
before running it, and a dropdown that fetches on the way past turns three
deliberate choices into three queries. A panel opts into this with
`loadOnFilter: false`.

Once loaded, a table shows **ten rows at a time** with Previous and Next under
it, and it is the same height whether the page holds two rows or ten, so
nothing walks up and down the screen while somebody reads.

The whole of it lives in `javascript/modules/shared/data-panel.js`, so a table
that loads on demand and a table that pages are the same table in two states
rather than thirty copies of the same logic.

## Who is actually here

The staff directory separates two facts that were being confused. **Active** or
**Inactive** is a decision an administrator made about the account. **Online**
or **Offline** is whether the person is at a screen right now.

The server answers the second from its own session store: every request
refreshes a session, and an open page sends a heartbeat once a minute so
somebody reading a report for ten minutes does not drop off the list while
sitting in front of it. It is memory only, on purpose — nobody is signed in to
a server that has just restarted, so the answer is right rather than merely
persistent.

## The audit trail

An entry used to be a staff id, an action name and a line of prose. It now
records the role the person held **at the time** (written down, not joined, so
a promotion cannot rewrite last month's history), the address the request came
from, the kind of action it was, and the before-and-after values of whatever
changed.

Failed sign-ins are recorded too, which they were not. Both kinds of failure —
an unknown email and a wrong password — are logged, and the reply to the
browser stays identical either way so nobody can use the difference to find out
which addresses exist.

The screen filters by action type and by date, and any entry opens to a
before/after table.

## Income, and the four ways to answer it

The **Collected** card on the manager's dashboard opens a breakdown over any
period: today, 7 days, 30, 90, six months, twelve, all time, or two dates typed
in. Named periods count back from today rather than snapping to a calendar
month, because "this month" on the third of the month is four days of trading
and reads as a collapse.

It answers one question four ways, because "how much did we make" means four
different figures to four different people:

| | |
|---|---|
| **Billed** | what was rung up, whether or not the money arrived |
| **Collected** | what is actually in hand, which is what pays the suppliers |
| **Outstanding** | what is still owed on it |
| **Discounts** | what was given away to get the sale |

Collected leads, because this is a shop with a credit book and billed income
that never arrives is not income.

Managers can export any of it as CSV or print it to PDF. Cashiers and clerks
get a daily tally on the screen for balancing a drawer, and nothing leaves the
building with them. That rule is enforced by the server, not by hiding a
button, because a hidden button is still a URL anybody can type.

## The reorder point the system works out for itself

```
ROP = (average daily sales x lead time) + safety stock
```

Average daily sales the system already knew: it is in the sale lines, counted
over the last ninety days of real trading rather than over all history. What it
did not know is how long a supplier takes and how much cover the shop wants on
top, so those two are now attributes of the product.

Each product is **Manual** or **Dynamic**. Manual keeps the number somebody
typed. Dynamic recalculates as the product sells faster or slower. It is a
per-product choice on purpose: a fast-moving consumable earns its formula, and
a slow item nobody has bought in a year would only get a reorder point of zero
out of one.

The calculated figure is shown beside the manual one either way, so the formula
can be judged before it is trusted, and switching a product to Dynamic asks
first and says what the new figure will be.

## Delivered is not the same as paid for

A driver hands over eight bags of cement on a COD order and marks it
Delivered. The goods have arrived and the shop has not been paid. Treating that
as finished is how a day's takings go missing.

So a delivered order with money still owed on it reads **Pending Cash
Collection**, and becomes **Completed** by itself the moment the payment is
recorded. It is derived from the sale's own figures rather than stored on the
delivery, which means there is no second flag to set and therefore none to
forget.

## Credit management

A credit limit on its own is not a policy. A customer who always pays and one
who has owed for four months both fit under the same limit, and only one of
them should be sold to on account.

**Standing** is what separates them, and it sits beside the limit because they
are one decision:

| | |
|---|---|
| **Good** | sell on account as normal |
| **Watch** | still allowed, but every screen says to look at this account |
| **Hold** | no new credit at all until a manager lifts it |

**At the counter**, the cashier sees the account the moment they pick the
customer — the limit, what is owed, and what can still be taken — rather than
finding out when the till refuses the sale with somebody watching. A sale can
be **part paid**: whatever is handed over is taken now, the rest goes on the
account, and the receipt shows both. Half now and half on the book is the
commonest credit transaction a hardware shop does and there was nowhere to put
it before.

**When a customer will not fit under their limit**, the cashier raises an
extension request from the till and the queue moves on. A manager sees it on
their own screen with the customer's balance and history beside it, and
approving raises the limit in the same transaction that closes the request, so
there is never a moment where one says yes and the other has not caught up.
Declining requires a reason, because "no" without one is a question the cashier
has to ask again tomorrow.

**Every customer** has a page showing purchase history and payment history side
by side. Neither means much alone: one says how good a customer somebody is,
the other how good a payer, and the shop needs both before extending anything.

## Returns: what happened, and where the goods went

Two things are compulsory on a return and neither used to be.

**The remarks.** Not a word — a sentence. "Damaged" explains nothing three
months later when a write-off is queried, and a stock count that disagrees with
the system by two bags of cement is settled by reading these lines. The counter
under the box says whether enough has been said while it is being typed.

**The disposition.** Where the goods physically go, said in words:

- **Return to Stock** — usable and sellable. It goes back on the shelf and the
  count goes up.
- **Exclude / Write-Off** — damaged, defective or unsellable. It never goes
  back, and a manager is told.

Neither is preselected, because a default here is answered by not being read,
and a return filed the wrong way used to leave the goods unaccounted for:
not on the shelf, not written off, still in a box behind the counter.

A write-off is read back before it happens, naming the quantity and the
product, because correcting one afterwards means a stock adjustment rather than
an undo.

## Asking before doing

Anything that cannot be taken back asks first, and the dialogue says what will
happen as a short list rather than a paragraph — a list of three lines gets
counted, prose gets skimmed. Deactivating an account, restoring over a live
database, deleting a backup, putting a customer on hold, writing stock off and
booking a sale to an account all go through it.

The dangerous ones look different from the routine ones on purpose. A dialogue
that asks "are you sure?" in the same voice for a saved filter and a wiped
database has taught everybody to press Confirm without reading it.

Popup messages stay long enough to be read: seven seconds for something that
failed, four for something that merely worked. The figures are named constants
in `ui-kit.js` rather than arithmetic buried in a function.

## Live sync across desktops

The shop runs on more than one machine. A clerk adjusts stock on the stockroom
PC and the cashier at the till is still looking at the figure from before the
adjustment, which is how two people sell the same last bag of cement. The only
fix used to be restoring the database by hand, which is not a fix.

So every signed-in browser holds one open connection to the server and is told
when something moves. **Server-Sent Events** rather than WebSockets: this is
one-way traffic — the server telling browsers something changed — and SSE is a
plain GET over the HTTP server that is already running. It reconnects by
itself, needs no new package, and opens no second port on a shop network.

What travels down it is deliberately **not the data**. A change says
"inventory moved, version 412" and nothing else; the browser decides whether
it is looking at anything affected and re-reads it through the normal route,
with the normal access check. Pushing rows down the channel would mean a
second copy of every permission rule.

Three pieces of restraint matter more than the refresh itself:

- **A table being read is never redrawn underneath.** Rows moving under a
  pointer lose the row that was about to be clicked. A panel only refreshes
  silently when nothing is in the way: no popup open, nothing focused inside
  it, and the reader on the first page. Otherwise the table says *"somebody
  else changed the inventory records"* in its own footer and waits to be asked.
- **A browser ignores the change it caused.** Every write carries a client id;
  a change stamped with our own has already been handled by whichever screen
  made it.
- **A lost connection is answered where it matters, not in the corner.** There
  used to be a dot in the top bar reporting the browser's connection to the
  server — green, crimson, amber, with a word beside it. It went in two stages
  and both were the same decision: it described the plumbing. A shop cannot act
  on "the change channel is reconnecting". There is no button for it, no
  procedure, and nothing the person at the counter is expected to do
  differently, so on every screen all day it was a standing distraction that
  answered a question nobody had asked.

  What a screen that has quietly gone out of date actually needs is the two
  things that survive, and both are about the rows in front of the reader
  rather than about a socket: a table that has fallen behind says so **in its
  own footer, in words**, and waits to be asked; and a screen that has fallen
  far enough behind to be untrustworthy is told to reload, as a card. That one
  is worth interrupting for.

  The state is still tracked and still drives both. It is simply not drawn. To
  put the dot back, build the element in `buildLiveIndicator()` in
  `shared/live-sync.js` and write the state onto it — the state names have not
  changed.
- **The dashboard tiles honour the badge above them.** The manager's five
  figures used to load once on arrival and never move again, with a green dot
  sitting directly over them. Anything that is not a table can now
  subscribe to the same scopes through `onLiveChange`, so the tiles re-read
  themselves when a sale, a payment, a stock move or a delivery lands. A
  background refresh that fails leaves the last good figures where they are
  rather than blanking them.

A browser that was disconnected long enough to fall behind the server's change
log is told to reload rather than shown a half-updated screen.

There is one hook on the server, not fifty: every write already passes through
the access-control middleware, so that is where a change is announced from. A
new route is covered the day it is written.

## Project layout

```
public/
  Login.html, change-password.html
  system.html               System Administrator dashboard
  manager-dashboard.html    Manager dashboard
  inventory-dashboard.html  Inventory Clerk dashboard
  cashier-dashboard.html    Cashier dashboard
  delivery.html             Delivery Personnel page

  css/
    general-ui.css          colours, type, the shell, and every component
                            two or more roles share
    responsive.css          the phone layout, for every role
    modules/
      login.css                    the sign-in and password screens
      system-admin.css             system.html
      manager.css                  manager-dashboard.html
      inventory-clerk.css          inventory-dashboard.html
      cashier.css                  cashier-dashboard.html
      delivery-personnel.css       delivery.html
    style.css               a signpost; the rules moved to the files above

  javascript/
    server.js               Express server and API routes
    mailer.js               SMTP, hand-written over Node's own tls
    modules/
      shared/
        helpers.js          the menu, tab switching, escaping, API headers
        format.js           money, badges, dates, the one fetch
        ui-kit.js           popup cards, the ask card, and how long each stays
        live-sync.js        the open channel, and what to refresh when it speaks
        tables.js           column alignment, and column names on a phone
        data-panel.js       tables that load on request and page ten at a time
        modals.js           open, close, backdrop, Escape
        detail-modal.js     the paged record popup
        session.js          signing in, the role guard, and the heartbeat
        topbar.js           the bell and the account chip
        my-account.js       my credentials
        notifications.js    the alert list
        deliveries.js       the delivery record, shared by three roles
      system-admin.js       system.html
      manager.js            manager-dashboard.html
      inventory-clerk.js    inventory-dashboard.html
      cashier.js            cashier-dashboard.html
      delivery-personnel.js delivery.html
    app.js                  a signpost; the code moved to modules/

  vendor/bootstrap/         Bootstrap 5, kept in the project, no internet needed
  database/
    0-READ-ME-FIRST.md                    how to run the two files below
    1-RUN-FIRST-database.sql              23 tables, 2 views, and the demo data
    2-RUN-SECOND-stored-procedures.sql    27 stored procedures
backups/                    dated .sql backups
  hardware_db_auto_*.sql      written every minute, oldest rotated away
  hardware_db_backup_*.sql    taken by hand, never rotated
tests/                      the checks described below
  mailer.js                 the SMTP client, against a fake mail server
  smoke.js                  every API route as every role, against MySQL
  regression.js             the bugs that were found and fixed, held down
  shots.js                  every screen photographed, against MySQL
  ui/                       every screen driven in a browser, with no MySQL
```

### Which files a page loads

Every page loads the same shared set, then the one file for its own role.
The order is not decoration:

```
css:  general-ui.css  ->  responsive.css  ->  modules/<role>.css
js:   shared/*        ->  modules/<role>.js
```

The general stylesheet sets the system, the responsive one overrides it for
small screens, and a role's own file has the last word on its own screens.

Adding a screen to a role means editing that role's two files and nothing
else. If a change would touch two roles it belongs in `general-ui.css` or in
`javascript/modules/shared/`, and that is the rule that keeps the five roles
from drifting apart.

## Checking that it still works

```
sh tests/run-all.sh
```

That runs `tests/mailer.js` first — it needs neither MySQL nor the server, and
drives the SMTP client against a fake mail server on a local port — then
rebuilds the database, restarts the server, runs `tests/smoke.js` (every
API route as every role, plus the rules that matter: that a cashier cannot
export a report or set a credit limit, that the reorder point matches its own
inputs, that a delivered order owing money is not Completed, that a return
cannot be filed without a reason or a disposition), then `tests/regression.js`,
then `tests/shots.js`, which signs in as all five roles with a real browser,
walks every screen, saves a screenshot of each into `shots/`, and reports any
console error or failed request it saw on the way.

`tests/regression.js` is the newest of the three and asks a different question
from the other two. `smoke.js` asks whether every route answers; this one asks
whether the answer is right, which is the question six defects got past while
every route was answering perfectly:

- the guard on `server.js` and `public/database/` tested the raw text of the
  address bar while the file server tested the decoded, collapsed path, so
  `//javascript/server.js` handed the database password to anybody who asked,
  signed in or not
- a sale checked stock line by line and deducted line by line, so one material
  written on two lines sold twice the shelf and left the count negative
- the end-of-shift **Collected** figure summed what customers handed over
  rather than what stayed in the drawer, so a broken banknote read as takings
- a staff id in the address bar decided whose shift and whose delivery round
  came back, so one cashier could read another's figures by editing a number
- report ranges were worked out against the UTC calendar while every figure
  they bound was worked out in SQL against the machine's own, so **Today** meant
  yesterday until eight in the morning Philippine time
- the two routes acting on your own account, and the one that changes the shop's
  tax registration, wrote audit entries with no role and no address on them

Each of those is now one line in that file, so the next change that reintroduces
one is a failing check rather than a discovery months later.

Every screen is photographed twice now, closed and loaded, because a table that
starts empty is a state worth being able to look at.

**Run the suites through `run-all.sh`, not on their own against a database you
have been using.** Each one signs the demo accounts in, and every account except
the administrator has to pick a real password on its first sign-in — so a second
run against the same database finds passwords that are no longer the ones in the
table above, and reports a wall of failures that are about the state of the
database rather than about the code. `run-all.sh` rebuilds from the two SQL files
before each suite for exactly that reason.

`tests/mailer.js` is the exception and can be run whenever: it touches neither
MySQL nor the server.

`tests/shots.js` needs Playwright:

```
npm install --no-save playwright
npx playwright install chromium
```

### Checking the screens without a database

```
sh tests/ui/run-all.sh
```

This one needs no MySQL at all. It starts `tests/ui/stub.js`, which serves the
project's own `public/` folder and answers the API with invented rows — 23
staff, 47 audit entries, 34 sales, 18 products, 21 deliveries, 17 credit
accounts, enough of each that paging, filtering and the empty states are real
rather than theoretical — and then drives every module in a real browser:

| Suite | What it walks |
|-------|---------------|
| `admin.js` | the directory, presence, the archive card, the audit trail, the backup drawer |
| `manager.js` | clickable cards, the income breakdown, tabbed reports, sales filters, the reorder formula, fulfilment states |
| `credit.js` | limits and standings, purchases beside payments, an extension raised at the till and decided by a manager |
| `returns.js` | the mandatory remarks and the disposition, on both refusals |
| `filters.js` | that a table still agrees with the dropdowns above it after two filters are changed in quick succession |
| `lazy-loading.js` | that every table starts closed and pages ten at a time |
| `live-sync.js` | two browsers at once: a change on one reaching the other, and the three cases where it deliberately does not redraw |

It proves nothing about MySQL; `tests/smoke.js` does that against the real
database. What it proves is that the screens behave, which is the half that is
tedious to check by hand. Screenshots of every step land in `shots/ui/`.

## Notes

- `database/` and `server.js` sit inside the folder Express serves, so the
  server refuses to hand them out; the pages, the stylesheet and `app.js` are
  served normally.
- Passwords are stored as scrypt hashes, never as readable text. A database
  restored from an older backup that still holds readable passwords is upgraded
  automatically the first time each person signs in.
- Every API route checks the session cookie and the role behind it. Nothing the
  browser sends decides what it is allowed to do.
