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
`hardware_db`, creates the 26 tables, loads the demo data, and then six months
of mock trading on top of it (see *Mock data* below).
`2-RUN-SECOND-stored-procedures.sql` loads the 3 views and the 30 stored
procedures; the tables have to exist before it will run.

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

There are two automatic upgrades, and both happen on `npm start`. The first:
`staff`'s old `middle_initial VARCHAR(5)` column is renamed to
`middle_name VARCHAR(100)` and `full_name` is rebuilt around it. The letters
already in there are kept and are still valid middle names of one letter, so
nothing is lost and nothing has to be retyped — fill in the whole name the
next time you open each record. The second: the three access-control tables
(`connected_systems` and `system_permissions`, see *Connected systems*
below, and `role_feature_permissions`, see *Screens by role*) are created if
they are missing, the five internal systems are registered, and the audit
trail's list of action types is widened to take the two new ones. Each
upgrade says so on the console when it does something
and does nothing at all on a database that already has it — but **re-run file
2 afterwards** if the console says to, because the two procedures the new
tables need only come from there.

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
All 30 stored procedures are loaded.
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

### Mock data

The demo data above is a handful of rows so every screen has something to
show. Section 8 of `1-RUN-FIRST-database.sql` then loads six months of
trading for a hardware shop in Nasugbu, Batangas, so the system can be tested
and evaluated against something that looks like a shop rather than against
tables with three rows in them: seven more staff (one of whom left in June),
twenty-six more customers with credit accounts in every standing, four more
suppliers, forty more materials with stock on the shelf, eleven purchase
orders, a hundred-odd sales with their lines and payments, deliveries at
every stage, returns, stock movements, credit extension requests, alerts and
an audit trail to match — including two people who hold a key to a
connected system (the manager may watch and run the backup; the senior clerk
may watch the database), so the Access Control screen has something to show
besides "Nothing".

The extra accounts sign in with the pattern `firstname12345` —
`liza.gonzales@hardware.com` / `liza12345`, `carlo.dizon@hardware.com` /
`carlo12345`, and so on; the directory lists them. Every one of them has to
choose a password on first sign-in, as above.

None of it is special. Every row is the kind a day's trading writes, and the
credit book deliberately holds one account of each standing worked out by the
rules below rather than typed in: one over its limit, one whose oldest debt
has passed ninety days, one being watched at forty-odd days, and the rest in
good standing. It is generated from a script with a fixed seed, so it is the
same on every machine and the ids continue from the demo data.

## Getting around

The menu on the left stays put while a page scrolls, and so does the bar across
the top, so the way out of a screen is always where you left it.

Navigation is two levels, each with one job. The menu on the left holds the
modules and is the same list all day. The strip across the top holds the
screens inside whichever module is open, and it changes as you move; on a
module that has only one screen it is not there at all. The strip is built
from the menu itself, so a screen a role cannot open never gets a tab. Which
screens a role's menu holds is the administrator's to change (see *Screens
by role*), and a screen with things waiting on it says how many, on the item,
on the heading above it and in the top bar (see *What is waiting, and where
it shows*).

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

## The register

The cashier's screen is the busiest in the system and the only one used with
somebody waiting, so it is laid out for that. The catalog is a **list**, one
product a line — name, category, brand, price, whether it can be sold, and
an Add button — rather than a grid of cards, because six hundred products
read faster down a column than across a wall, and the prices sit in one
column where they can be compared. The Add button is the only thing that
puts a product on the order; pressing the line anywhere else opens the
product on a card — everything the catalog knows about it, with its own Add
button — because a row that adds on a press adds a bag of cement when
somebody meant to read about it. A product that has run out says so on its
line and on its card, and neither will add it.

**Counted and measured.** A bag of cement is counted, and Add puts one on
the order; nails are weighed and wire is cut, so a product sold by the
kilogram, gram, metre, litre, foot or gallon is *measured*: Add opens a
card asking how much — *2.5* kg — with what is on the shelf as the ceiling,
the cart line reads *2.5 kg* and its − / + step by a half, and the amount
can be retyped by pressing it. Which a unit is comes from its name
(`MEASURED_UNITS` in `shared/format.js`); every other unit is counted. The
quantity columns behind this — stock on hand, sale lines, adjustments,
returns — take three decimal places, and the server widens them on a
database from before at startup; **re-run file 2 afterwards**, because the
procedures that read them come from there and until then a fraction is
rounded inside the procedure, as it always was.

The printed invoice carries a **Total Items Purchased** line above the
subtotal: the quantities added up, and the number of lines beside it when
that is a different figure (*5 (2 lines)*), so what is counted at the gate
or against the delivery is the figure on the paper.

The **search finds the typed letters anywhere** in a name, a category or a
brand: *ad* finds Shade, Adapter and Thread. Everywhere else in the system a
search matches the start of a field, because a directory searched for *an*
returns most of the directory; the catalog is the one place that rule is
wrong, because a product at a counter is asked for by whatever part of its
name the customer said. Two filters beside the search narrow the same list,
by category and by whether the product is in stock.

The catalog and the order **scroll on their own**, each inside its own
column the height of the window: running down the list never carries the
total off the screen, and a long order never pushes the catalog out of
reach. On a narrow screen the two become one column and the page scrolls as
a whole. And the three screens of the till — New Transaction, Deliveries,
Refunds — are listed under **Point of Sale** in the menu, folding open and
shut under the heading the way the manager's Credit does, rather than as a
strip of tabs across the page.

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

View my credentials opens a card, and what is behind it depends on who you
are.

**A standard user — manager, clerk, cashier, driver — edits their name and
phone number, and nothing else.** The card has two tabs:

- **Credentials** — everything the system holds about you.
- **Edit Details** — first name, middle name, last name and phone. The email
  you sign in with is shown for checking and cannot be changed here, and
  neither can your role.

There is no Password tab. A credential is the thing that gets somebody in —
the sign-in email, the password, the role — and none of the three is changed
by its own holder from their own screen. The email is the username, and a
username somebody can change for themselves is a username the audit trail
loses track of. The password is the one that matters: a screen left signed
in at a counter is otherwise a screen on which anybody who sits down can set
a new password and own the account from then on, and asking for the current
one first only helps if the person who sat down does not know it.

So a new password comes from the administrator: **Reset Password** on the
staff card makes one the way a new account's is made (see *The first
password* below) — nobody types it, it is mailed to the address on file,
every screen the person has open is signed out, and the system asks for a
password of their own choosing on the next sign-in. Nobody but the owner
ever knows the password they end up with. The server refuses the two routes
whichever screen sends them (`notOwnCredentials` in `server.js`).

**The System Administrator is the other way round.** They keep the Password
tab — an administrator locked out with nobody above them is a shop that is
locked out — and lose the Edit Details tab: the account that can rename,
re-role, deactivate and reset anybody in the directory does not also do those
things to itself with nobody else on the audit trail. An administrator's own
details are changed by another administrator from the staff directory, and
the directory refuses the administrator's own row: their card has no Edit tab
and its buttons are off, and the server refuses the requests whichever screen
sends them (`notOwnAccount` in `server.js`).

**Changing a password ends every session the account holds**, the one that
made the change included, and the browser is sent back to sign in with the
new one. A password is changed because the old one might be known to
somebody else, and a session that old password opened should not outlive it;
and a new password nobody has typed at the sign-in screen is a new password
nobody has checked.

## One person, one session

Signing in ends every other session the same account holds. The screen left
behind on the other machine is told at once over the live channel, sent back
to the sign-in page, and shown why — "This account signed in on another
device, so this screen was signed out." The audit trail records it as
`SESSION_REPLACED`. A till that stays open under a cashier who went home was
the reason.

The menu used to list all three as items of their own. All three opened the
same card, which then showed its tabs anyway, so the menu was offering three
doors into one room. It offers the door and the room does the rest.

## The first password, and who is allowed to know it

**Nobody types the first password**, and **the account is not created until
somebody has read it back.** Creating an account is two steps:

1. Fill the form in — a name, a role, a phone number, an email address — and
   press **Create**. Nothing is created yet. The server works the whole
   account out, makes the password, and shows you the lot: the name as the
   directory will spell it, the middle name, the role, the number as it will be stored,
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

**Reset Password** on an existing account is the same machinery. Nobody types
the new password: the server makes one, mails it, ends every session the
account holds, and the person chooses their own on the next sign-in. If the
mail cannot go, the password comes back to the administrator's screen once,
as it does for a new account.

## Alerts

The bell in the top right corner holds every alert for your role: low stock,
out of stock, damage and refund reports, a purchase order the clerk should
expect a delivery against, and deliveries that have just been booked. Unread
ones are marked and carry a yellow edge.

Every alert says three things, in the panel and on the popup card alike: what
happened, **who** raised it, and **when** — as a date and time plus how long
ago that was, so you can tell this morning's problem from last month's. An
alert nobody caused, such as one the system raised on its own, says "System".

New alerts also appear as cards in the bottom right corner of the screen.
Clicking one opens the full list. They step aside on their own after a few
seconds; the bell keeps them.

## Phone numbers

**Philippine numbers, and one spelling of them: `+639171234567`.** The box
takes the ten digits after `+63`, or the whole number the way everybody
writes it, `09171234567`, and stores both the same way. A number under any
other country code is refused, in the browser as it is typed and on the
server as it arrives, with the two spellings that are taken. The shop is in
Nasugbu and its staff, customers and suppliers are reached on Philippine
numbers; a column that could hold a number from anywhere was a column
nobody could be sure of dialling.

The picker below still knows every country, because the rule is one line
(`PHONE_ONLY_COUNTRY` in `phone-picker.js`, and `phoneComplaint` in
`format.js` and `server.js`) and a shop that one day takes a number from
abroad sets it to `null` and gets the button back. Until then the country
beside the box is printed, not pressed.

The box used to be plain text, so it took anything: letters, spaces, brackets,
`n/a`, and the same number written as `09171234567`, `+639171234567`,
`639171234567` and `0917 123 4567` by four different people on four different
afternoons. Four spellings of one number is a column that cannot be searched,
cannot be compared, and cannot be dialled from without being read by a human
first. For a while after that it took a number from any country, with a
button beside the box to pick one; that has gone back to one country, for
the reason above.

So the box is the country, printed, and the number as it is dialled inside it:

```
 PH +63 | 9171234567
```

Everything that is not a digit is dropped as the keys are pressed, rather than
complained about after the form is submitted — a rule that refuses a keystroke
teaches the rule in the moment, and a rule that refuses the form at the end
teaches nothing and loses the other nine fields. The trunk `0` goes the same
way: `0917…` is `+63 917…`, because with the code in front the `0` is never
dialled, so the whole number can be typed as it is written on a card. A
number is then held to what a Philippine mobile number is, ten digits
starting with `9`. One pasted with another country's code in front is left
in the box and refused with the reason — *Only Philippine numbers are
accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX* — rather than quietly
reshaped into a Philippine number it never was.

An incomplete number turns the box amber while it is being filled in, and says
nothing at all while it is empty, because the number is optional.

The same rule is enforced again in `server.js`, because a check that only exists
in a browser is a check anybody can skip with `curl`. A number is stored as
`+639171234567` and shown as `+63 917 123 4567`, spaced the way it is read out.

Numbers already in the database from before this rule are rewritten to `+` form
on the next `npm start`. Anything that does not reduce to a usable number is
cleared rather than half-converted, and the server says how many — a phone
column with `n/a` in it is a column somebody will eventually try to dial.
A number from another country already on file is treated the same way now
that only Philippine numbers are taken: it is cleared at startup and counted
in that line, so check the console the first time the server starts after
this change.

## Money

Every amount in the system is Philippine pesos and reads as one: `₱1,250.00`.
The sign is put on by `peso()` in `shared/format.js`, the one function every
figure of money goes through, so there is no screen that prints a bare
number and leaves the reader to know the currency. The spreadsheet export
strips it again on the way out, so a column of money lands in the sheet as
numbers.

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

## Fewer columns, and the rest a press away

A seven-column table is read by nobody: the eye finds the name and the one
figure it came for and skips the rest, and the rest is still taking the
width. So every table with more to say than fits a glance shows its main
columns and keeps the others off the grid until asked for. A heading is
marked in the page —

```html
<th data-secondary>Supplier</th>
```

— and `shared/tables.js` does the rest: the column is hidden, a switch
appears above the table, *Show 3 more columns* / *Fewer columns*, and the
reader's choice is remembered per table on that browser. The Reorder Alerts
table went from eight columns to five this way; the staff directory lost its
ID column, the audit trail its IP address, the credit book its open-sales
count and oldest debt. Nothing is dropped: the spreadsheet export and the
print still carry every column, because a report read away from the screen
has no switch to press.

The details are one press away either way. A row that opens a popup of its
own — most of them do — opens it as before, and the popup carries
everything. A row that has no popup unfolds in place: pressed, it shows a
line underneath naming the hidden columns and their values, and pressed
again it folds back. The chevron at the start of such a row is what says it
will.

## Tables that wait to be asked

Every table in the system starts closed. It shows a search box, whatever
filters it offers, and a **Load Data** button, and it queries the database when
somebody picks a filter, presses the button, or types a search and presses
**Enter** — and not before. Nothing is read on the way into a screen, the
driver's run included: one **Load Data** on any of the driver's three lists
reads the run once and fills all three.

### Searching

A search runs when **Enter** is pressed, not on every keystroke, so nothing
goes to the server until the person has finished typing; **Escape** clears it.
And a search matches the **start** of a field: `ros` finds Rosa Villamor and
`rosa@hardware.com`, and not everybody whose name merely contains those
letters. The server's queries use `LIKE 'text%'` and the screens filter their
rows by the same rule (`prefixMatch` in `shared/data-panel.js`), so the two
never disagree.

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

## Who may do what

Access is decided on the server, in one table — `ACCESS_RULES` in
`server.js` — that names, for every `/api` route, which roles may call it.
Anything under `/api` with no rule is refused. The routes that replace or
destroy data (backups, restores, the receipt details, credit limits and
decisions) carry `requireRole(...)` on the route as well, so that a rule
loosened by mistake still meets a second no.

The pages are checked the same way. `system.html` is served to a System
Administrator and to nobody else; each dashboard to its own role. With no
session the browser is sent to sign in, and with the wrong role it is sent to
its own dashboard. On the page, any element marked
`data-access="Manager,System Administrator"` is removed for every other role,
so a screen two roles share does not show the second a button that would only
ever answer "not allowed". Hiding is never granting: the server's answer is the
one that counts.

## Connected systems, and who may touch them

A role says what somebody does in the shop. It says nothing about whether
they may reach past the shop into the systems around it: the MySQL database
underneath, the backup that ticks on its own, the nightly archive sweep, the
live channel between the desktops, the mail relay first passwords go out
through — and whatever outside service the shop later plugs in, a courier's
tracking API or a supplier portal or a second branch. None of that is a sale
or a stock count, and a Manager is no more entitled to pause the backup than
a Cashier is.

So reaching those is **a permission and not a role**, held by one person on
one system at one of three levels, and by default nobody holds any:

| Level | Lets the person |
|---|---|
| **Monitor** | read the system's state — the card on the Connected Systems screen |
| **Manage** | change how it is set up: switch it on or off, rename it, change the address an external one answers at |
| **Control** | run commands against it: take a backup now, pause or resume the timer, run the sweep, send a test mail, ping a remote service or post it a message |

Manage and control both include monitor, and the database procedure forces
that whichever screen or tool sent the request: nobody may command what
they cannot see. The System Administrator holds every level on every system
by role and is the only one who hands them out.

**Where it is done.** Access Control on the administrator's page has two
screens. *Who Holds Access* lists every person with a login who is not an
administrator — including the ones who hold nothing, because that is the
default and the screen has to be able to show it — and opening a person
gives a matrix: one line per system, the three levels as boxes, and a line
for why. Ticking control ticks monitor with it; Save reads the changes back
first, in a card that turns crimson when control is among them. *Connected
Systems* is the systems themselves, and it is the same screen every other
dashboard carries.

**Where it shows.** Every dashboard has a Connected Systems entry in its
menu, hidden. It is unhidden only once the server (`/api/me/access`) says
the person holds a key to something, and hidden again over the live channel
the moment the last key is taken back — with no reload, and with the screen
saying so if it happens to be open. A cashier granted control of the backup
sees one card with its commands; the same cashier granted monitor on the
database sees a second card with none. Nobody else sees the entry at all.

**How it is enforced.** Not from the session. The three levels are read
from `system_permissions` on every request under `/api/systems`, so a
revocation bites on the very next call rather than at the next sign-in. The
access table in `server.js` lets any signed-in person *ask*, and each route
then carries `requireSystemAccess('monitor' | 'manage' | 'control')`, which
looks the grant up and refuses with the level that was missing. Handing out
keys is under `/api/access` and administrator-only; `notOwnAccount` is on
the route as well, and the procedure refuses a grant to any administrator,
to a person with no login, or to a deactivated account (keys can still be
taken back from those).

**What is written down.** Two new kinds of audit entry, filterable on the
Audit Trail as *Access granted / revoked* and *Commands run on
connected systems*:

- `GRANT_SYSTEM_ACCESS` and `REVOKE_SYSTEM_ACCESS` — who was given or lost
  what on which system, with the levels before and after and the reason the
  administrator typed. A save of the same three boxes writes nothing.
- `SYSTEM_ACTION` — every command, by whoever ran it, whether it worked, and
  what it reported (the backup file it wrote, the HTTP status the remote
  answered). A command that failed is an entry too, with the reason.
- `SYSTEM_ACCESS_DENIED` — somebody without the key trying the door. The
  role-based refusals elsewhere are ordinary screens hiding ordinary
  buttons; this one is a person reaching for something they were never
  offered, which is exactly what an audit is opened to find.
- `CREATE_CONNECTED_SYSTEM` and `UPDATE_CONNECTED_SYSTEM` — a system
  registered, renamed, re-addressed, or switched off and on.

Each carries the role held at the time and the address it came from, like
every other entry.

**The internal systems** are seeded by file 1 and re-seeded by the server
if any is missing, keyed by names `server.js` knows how to answer for
(`INTERNAL_SYSTEMS`). **An external system** is registered from the
Connected Systems screen with a key that never changes, a name, and the
`http://` or `https://` address it answers at — no username or password in
it. Its status is whether that address answers, read with a five-second
patience and shown as a state rather than an error when it does not; its
commands are to ask it again and to post it a short JSON message signed
with who sent it. A system switched off keeps its row and its grants and
takes no commands until it is switched back on, which is a manage change
made on purpose.

## Screens by role

A role decides what somebody does, and each role's menu is written into its
own page: a manager's page lists the manager's screens, a cashier's the
cashier's. That is the right default and it was rigid. A cashier who also
loads the van could not be shown the delivery schedule without being made a
manager, and a clerk who should not be resolving returns kept the screen
because every clerk did.

So every screen is now an entry in a catalogue (`FEATURES` in `server.js`):
its name, the roles whose page can draw it, the roles that hold it by role,
and the routes it is made of. **Screens by Role**, under Access Control on
the administrator's page, is that catalogue as a matrix — one row per screen,
one column per role, each cell a switch — and the administrator can:

- **switch a screen off** for a role that holds it by role. Refunds off the
  cashiers, say, or Adjustment History off the clerks.
- **switch a screen on** for a role whose page can draw it but does not hold
  it by role. Today that is the **Delivery Schedule** — the deliveries still
  to go out, under Overdue, Today, Tomorrow and Later — which the manager
  holds by role and any of the other three can be given.

A cell the switch cannot reach is shown as a dash: that role's dashboard has
no such screen, and a menu item with nothing behind it is a dead end, not a
feature. The System Administrator is not in the matrix at all; the
administrator's screens are the administrator's by role and nobody grants
them anything. The word under each switch says what it means for that role —
*by role*, *granted*, *off* — and Save reads the changes back first, in a
card that turns crimson when a screen is being taken away, because somebody
may be standing in front of it.

**Where it shows.** Every menu item on the four staff dashboards names the
screen it opens (`data-feature="credit-requests"`), and
`shared/features.js` asks `/api/me/features` which screens the role holds
and hides or unhides the items to match — on arrival, and again over the live
channel the moment a switch is thrown, with no reload. A heading whose
screens have all been taken away goes with them, and the strip of tabs
across the top follows the menu. If the screen somebody is looking at is
switched off while they are on it, their page goes back to its first screen
and says why. The Delivery Schedule is drawn by `shared/delivery-schedule.js`
rather than written into a page, the way the Connected Systems screen is,
because a screen that can land on any page has to be able to draw itself on
any page; its menu item is in each page's markup, hidden until the role has
it.

**How it is enforced.** Not by the menu. Each screen lists the routes it is
made of, and the access hook in `server.js` reads them after `ACCESS_RULES`
has had its say:

- a route is **refused once every screen using it is switched off** for the
  role. A route two screens share — `/api/stocks` under both Reorder Alerts
  and Stock Reports — is not refused while either is still held.
- a route the role table would refuse is **allowed when the role holds a
  screen that needs it by grant** — an override, not a default. A screen held
  by role has its routes in the role table already, and a default never
  widens them: the cashier's Delivery Tracking is read-only by role, and
  granting the cashiers nothing new leaves it so. A clerk given the schedule
  may read `/api/deliveries` and still may not move a delivery along.

The overrides are one row each in `role_feature_permissions`, and only the
administrator's changes are rows — set a switch back to what the page has and
the row is deleted, so an empty table means every menu is exactly what its
page says. Read on every request rather than kept on the session, like the
connected-systems grants, so a revocation bites on the very next call; cached
in memory between writes, because it is a few rows. Every switch thrown is on
the audit trail as `GRANT_SCREEN` or `REVOKE_SCREEN`, filterable as *Access
granted / revoked* beside the connected-systems keys. The table is created by
the server at startup on a database from before it existed, the way the
access-control tables are.

Making another screen grantable means drawing it by script the way the
schedule is (so any page can carry it), giving each page a hidden menu item
for it, and listing the roles whose pages have one under `available` in the
catalogue. A screen that is only ever on one page needs none of that: its
entry in the catalogue is what lets the administrator switch it off.

## What is waiting, and where it shows

A request nobody sees is a queue at the till nobody knows about. A menu item
with things waiting on it carries the number — the manager's Extension
Requests has for a while — but that number was only visible once the heading
above it had been folded open, which is to say, only to somebody who already
knew to look.

So every count on the menu now shows in three places:

- **on the item**, as before: *Extension Requests 2*;
- **on the heading above it**, added up across the items under it, while the
  heading is folded: *Credit 2*, *Stocks 3*. It steps aside while the list is
  open, because then the item's own badge is in view and the same number
  twice, one above the other, reads as two queues;
- **in the top bar**, beside the bell, as one chip that adds up every count
  on the menu — *10 waiting* — and opens to a list of what is waiting where.
  A line on the list presses the menu item it names, so there is one route
  into each screen and nothing to keep in step.

The counts come from `/api/me/counts`, one small query each, for the screens
the person holds and no others: pending extension requests and pending
deliveries for the manager, materials at or under their reorder point for the
manager and the clerk, open returns for the clerk, the driver's own pending
run, and deliveries due today or overdue for whoever holds the schedule. They
are read on arrival and again whenever the live channel says the tables
behind them moved, so the number on the menu is the number in the table and
not the number from when the page opened. The module scripts still write the
same badges when their own tables load, and the mirrors follow whichever
wrote last.

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

Under the figures and the chart sits one table at a time — Payment Method,
Best Sellers, or Who Sold It — chosen from the **Income** entry in the menu,
which folds open to list the three. The entry for the table on the screen is
the marked one, so the menu and the page can never say two different things,
and the other two tables are one click away rather than two screens down.

**Reports** and **Records** work the same way. Each is one screen holding one
table at a time — four reports, five kinds of record — and the one showing is
chosen from the entry in the menu, which folds open under the heading the way
Income does. Reports also carries a dropdown at the top of its card, because
a report is often switched while it is being read; both call the same
function, so they always agree. Records has no second control: the card is
headed with the kind of record showing, and the menu is beside it.

### Two ways off every screen

Every table the manager reads has the same pair of buttons in its corner:

| | |
|---|---|
| **Spreadsheet** | a CSV of every row that survived the search and the filters, not only the ten on the page. It opens in Excel, LibreOffice or Google Sheets |
| **Print / PDF** | the browser's own print dialogue, with the table unpaged for the duration so paper gets all of it. Save as PDF is in that dialogue |

Both are dead until the table holds rows. A Print button that can be pressed
over an empty table prints an empty table; a grey one says "not yet". The
income breakdown is exported by the server rather than assembled from the
page — it is the one report the export route was built for, it carries the
same period the screen was loaded with, and it is the one export that is
audited. Cashiers and clerks get a daily tally on the screen for balancing a
drawer, and nothing leaves the building with them. That rule is enforced by
the server, not by hiding a button, because a hidden button is still a URL
anybody can type.

### The shelf, read by quantity

Stock status says whether a product is under its reorder point, which is a
rule about ordering. It says nothing about how much is actually on the shelf,
which is the question a manager walking the stockroom is asking. So the stock
report also filters by quantity — nothing on hand, below the reorder point,
within a quarter above it, or a band of round numbers — and sorts by what is
on hand, by how far under the reorder point a product has fallen, by stock
value, or by days of cover.

## Purchase orders: raised upstairs, counted in at the door

Buying is a manager's decision, so a purchase order is raised on the manager's
page: name the supplier, list the materials, send it, and the printed order
opens ready to hand to a company that has no login to this system. The
supplier is typed rather than picked, and so is each material, because a
purchase order is how a shop buys something it does not have yet, often from
somebody it has not bought from before.

Receiving is the manager's too: the count sheet — what was ordered on the
left, what came off the lorry typed on the right — books the goods onto the
shelf and closes the order.

The clerk's page keeps a read-only copy. Every order is listed there as a
reference — what is meant to arrive, and from whom — with the printed sheet
to hold beside the delivery receipt when it does. There is no form on the
clerk's page and no Receive button, and the server refuses a clerk who calls
either route anyway.

The screens are one piece of code (`shared/purchase-orders.js`) that each
page configures with what it is allowed to do, so the two desks cannot
disagree about what an order is.

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

**Standing** is what separates them. It is the one word that says whether to
sell to this account on credit today:

| | |
|---|---|
| **Good** | sell on account as normal |
| **Watch** | still allowed, but every screen says to look at this account first |
| **Hold** | no new credit at all |

### What standing means, exactly

Standing used to be a word a manager typed and nobody recalculated, so an
account that had owed for four months read Good until somebody remembered to
change it. It is **worked out from the figures now, every time it is read**,
by `vw_customer_credit`, and the rules are these:

| Standing | Any one of |
|---|---|
| **Hold** | the balance owed is over the credit limit; the oldest unpaid sale is more than **90 days** old; a manager has put the account on hold |
| **Watch** | the oldest unpaid sale is more than **30 days** old; the balance owed is **75%** or more of the credit limit; a manager has flagged the account |
| **Good** | none of the above, including an account that owes nothing |

The manager's word is an **override upwards**. A manager can put a Good
account on Watch or Hold — a cheque that bounced is a fact the figures do not
know yet — but cannot mark an account Good while the figures say otherwise:
on the credit card the control is called *Standing override*, and setting it
to *None* means "let the figures decide". The three thresholds are the three
numbers in the view, and a shop that wants sixty days instead of ninety
changes them there and nowhere else.

Every screen that shows the badge also says **why**: the reason names the
first rule that applied, in the same order the tier was decided — "Over the
limit by 1,200.00", "Oldest unpaid sale is 97 days old; the limit is 90",
"Owes 76% of the limit; watched from 75%", "Put on hold by a manager: cheque
returned in July". It is a tooltip on the badge in the credit book, a line on
the account card, and the note under the credit strip at the till, so a
cashier told the sale will not go through is told the reason in the same
breath. The sale procedure reads the same computed standing, so the till and
the manager's screen cannot disagree about who may buy on account.

**On the cashier's own credit book** the last column is not the standing
but the **due date**: the oldest unpaid sale plus the shop's term of thirty
days — the same thirty days after which an account's standing turns to
Watch, so the two screens agree about who is late. Each row says the date and
how far off it is, *due in 12 days*, *3 days overdue*, and the filter beside
the search narrows the book to what is overdue, due within the week, owing,
or clear. The question at a counter is "when does this customer have to pay",
and a tier is one word further from it than a date.

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

## What "archived" means, and when it happens

Nothing in this system is deleted. A record that is finished with is
**archived**: it leaves the live lists and the figures, keeps every field it
had, shows on the manager's **Archives** screen with who archived it and
when, and can be restored from there. What "finished with" means is
different for each of the four kinds of record, and so is who decides:

| Record | Archived means | By hand | On its own |
|---|---|---|---|
| **Staff** | the account is deactivated and cannot sign in | the administrator, from the staff card; the last active administrator cannot be | never — a person leaving is a decision |
| **Material** | the shop no longer stocks it: off the material list, the catalog and the register | the clerk or a manager, from the material card, and only once nothing is left on the shelf and no purchase order for it is open | nightly, once it has had **no stock, no sale, no stock movement and no open order for 180 days** |
| **Sale** | it is **voided**: it reads Voided on every screen and counts for nothing | a manager, from the sale's card, **on the day it was made only**, and only while its goods are not out for delivery | never — an old sale is corrected with a return or a refund, which keeps the money trail |
| **Delivery** | it is closed: Delivered with the sale paid for, or Failed | a manager, from the delivery's card, once it is closed | nightly, **90 days** after it closed |

The rules live in the database rather than in the screens — `sp_archive_record`
holds the manual ones and `sp_sweep_archives` the automatic ones — so a
request that breaks one is refused with the reason whichever screen sends
it, and the two sets cannot drift apart.

**Voiding a sale puts the stock back.** Every line on it goes back on the
shelf with an entry in the stock log saying which sale was voided, a delivery
booked for it and not yet on the road is cancelled with it, and restoring the
sale takes the stock off again — and is refused if that stock has since been
sold to somebody else. Money already taken is not touched: a void is for a
sale rung up twice, and the cash for the duplicate is handed back at the
counter. The same-day rule is what keeps that honest; a sale from last week
that was wrong is a return, not a void.

**A material with stock on hand cannot be archived.** A shelf the system has
stopped counting is a shelf somebody counts by hand in three months and
cannot explain. Sell it off or write it off first, and then it can go.

**The sweep** runs when the server starts and once a day after that. Ninety
days is three statement cycles — long enough for any query about a drop to
have come and gone — and a hundred and eighty days with nothing on the shelf
and no movement is dead stock. Each run that put something away writes one
line to the audit trail saying what and how many, with no staff id, so the
Archives screen shows "System" against those rows. Nothing else is ever
archived automatically.

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
    purchase-orders.css     the order form, the printed order and the count
                            sheet, on the manager's page and the clerk's
    connected-systems.css   the system cards, on every dashboard
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
        purchase-orders.js  raising, printing and counting in an order,
                            shared by the manager and the clerk
        connected-systems.js the systems beyond the shop, shown to whoever
                            holds a key to them, on every dashboard
        features.js         the menu as the administrator has set it for the
                            role, and the counts mirrored onto headings and
                            into the top bar
        delivery-schedule.js the deliveries still to go out, by the day they
                            are due; drawn by script so any page can carry it
      system-admin.js       system.html
      manager.js            manager-dashboard.html
      inventory-clerk.js    inventory-dashboard.html
      cashier.js            cashier-dashboard.html
      delivery-personnel.js delivery.html
    app.js                  a signpost; the code moved to modules/

  vendor/bootstrap/         Bootstrap 5, kept in the project, no internet needed
  database/
    0-READ-ME-FIRST.md                    how to run the two files below
    1-RUN-FIRST-database.sql              26 tables, the demo data, and six
                                          months of mock trading
    2-RUN-SECOND-stored-procedures.sql    3 views and 30 stored procedures
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
The manager's page and the clerk's also load `css/purchase-orders.css` and
`shared/purchase-orders.js` between the shared set and their own file, for
the one feature the two desks share. Every page loads
`css/connected-systems.css` and `shared/connected-systems.js` the same way,
for the one screen every desk carries and almost none of them show. The
four staff pages also load `shared/features.js` and
`shared/delivery-schedule.js`: the first shapes the menu to what the
administrator has switched on for the role, the second is the one screen
any of them can be given (see *Screens by role*).

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
cannot be filed without a reason or a disposition, that a cashier holds no
connected system until granted one and loses it on the very next request
when it is revoked, and that every grant and every command is on the trail),
then `tests/regression.js`,
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

`run-all.sh` starts the server with `HARDWARE_MAIL_OFF=1`, which makes
`mailer.js` report that mail is not set up whatever the SETUP block says.
The passwords the server makes for new and reset accounts then come back in
its replies, where the checks can sign in with them, instead of going to a
real inbox nobody is watching. It is an environment variable rather than a
setting so it cannot be left switched on by accident in the file people edit.

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
| `admin.js` | the directory, presence, the archive card, the audit trail, the backup drawer, the access matrix and the system cards |
| `manager.js` | clickable cards, the income breakdown with its tables chosen from the Income dropdown, the Spreadsheet and Print pair dead until a table has rows, the reports and the kinds of record as screens in the strip, sales filters, the stock report sorted and filtered by quantity, the reorder formula, raising a purchase order, fulfilment states |
| `credit.js` | limits and standings, purchases beside payments, an extension raised at the till and decided by a manager |
| `returns.js` | the mandatory remarks and the disposition, on both refusals |
| `filters.js` | that a table still agrees with the dropdowns above it after two filters are changed in quick succession |
| `lazy-loading.js` | that every table starts closed and pages ten at a time, and that the clerk can read a purchase order but neither raise nor receive one |
| `live-sync.js` | two browsers at once: a change on one reaching the other, and the three cases where it deliberately does not redraw |
| `features.js` | the administrator switches a screen on for the cashiers and off again; the cashier's menu and tab strip follow with no reload, and the counts on the manager's menu show on the heading above them and in the top bar |

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
