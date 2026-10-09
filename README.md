# Lucelyn Hardware — Online Sales and Inventory with Credit Management

A point of sale, inventory, and customer credit system. Node with Express on the
server, plain HTML, CSS, Bootstrap 5 and JavaScript on the client, MySQL 8 for
the data.

> **Putting it online?** [DEPLOY-VERCEL-AIVEN.md](DEPLOY-VERCEL-AIVEN.md) runs the same
> app on Vercel with the database on Aiven MySQL.

## Setup on a new computer

You need MySQL 8.0 or newer and Node 20 or newer installed first.

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
`hardware_db`, creates the 33 tables, loads the demo data, and then six months
of mock trading on top of it (see *Mock data* below).
`2-RUN-SECOND-stored-procedures.sql` loads the 3 views and the 36 stored
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
next time you open each record. The second: the `role_feature_permissions`
table (see *Screens by role*) is created if it is missing, and the audit
trail's list of action types is widened to take the *Access* kind. Each
upgrade says so on the console when it does something and does nothing at all
on a database that already has it.

Two more arrive the same way. `store_settings` gains `bank_name`,
`bank_account_name` and `bank_account_number` (see *Bank transfers* below),
and the `password_resets` table is created for "Forgot your password?". Both
are added on `npm start`, and the server then finds fewer procedures than it
expects (31 of 33) and **loads file 2 by itself**, so restarting the server is
all an existing database needs. Running file 2 by hand does the same.

Earlier versions of the project shipped `upgrade.sql` through `upgrade_v8.sql`
and `fix_patch.sql` for stepping an existing database forward one version at a
time. Every change they made is now inside `1-RUN-FIRST-database.sql`, so they
did nothing on a machine that ran the schema fresh. They have been removed; git
history still has them.

### 4. Point the server at your MySQL

Copy `.env.example` to `.env` in the project folder and fill it in:

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your-mysql-password
DB_NAME=hardware_db
DB_PORT=3306
```

`DB_PASSWORD` is the MySQL root password on the new machine. The file is
read by `dotenv` when the server starts and is ignored by git, so the password
never lands in the repository; `server.js` warns at startup if it is missing
or still a placeholder.

Everything else the server can be told is in the same file, and every one of
them has a working default, so they can be left out:

| Setting               | Default              | What it does                                      |
|-----------------------|----------------------|---------------------------------------------------|
| `HARDWARE_PORT`       | `3000`               | the port the app listens on                       |
| `SESSION_HOURS`       | `8`                  | how long a sign-in lasts without signing out      |
| `TRUST_PROXY`         | `0`                  | `1` only behind a reverse proxy you control, so the audit trail reads the visitor's address from `X-Forwarded-For` |
| `HARDWARE_BACKUP_DIR` | `backups/`           | where Backup & Recovery writes its `.sql` files   |
| `MAIL_*`              | mail off             | the mail account; see the next step               |

Nothing about the machine, the account or the shop is written into a source
file. `.env.example` lists every setting with a note beside it.

### 5. Point the server at a mail account (optional)

The system sends three kinds of email: the password for an account somebody
has just been given (or had reset), the six-digit code behind "Forgot your
password?", and a confirmed purchase order to its supplier. It works without
this step — a new password is shown once on the screen instead, to be handed
over; the sign-in page says codes cannot be sent and who can reset a password
instead; and a confirmed order tells the manager to print it and send it — so
leave it until the rest is running.

Add the mail account to the same `.env`:

```env
MAIL_HOST=smtp.gmail.com
MAIL_PORT=465
MAIL_USER=shop@gmail.com
MAIL_PASSWORD=the-app-password
MAIL_FROM_NAME=
```

With `MAIL_USER` or `MAIL_PASSWORD` empty, mail is simply off and the fallback
is used. `MAIL_FROM_NAME` is the name on the From: line; left empty, the mail
is signed with the shop's name from System Administration. Since `.env` is in
`.gitignore`, the account stays on the machine and never reaches GitHub; every
computer this is set up on fills in its own. (A machine set up before these
settings existed may still have the password in
`public/Back-end/mail-password.txt`; that still works, and `MAIL_PASSWORD` wins
when both are present.)

**For a Gmail account,** `MAIL_PASSWORD` is not the password you sign in to
Gmail with — Google refuses those over SMTP. Turn on 2-Step Verification on the
account, make an App Password (16 letters) at
`myaccount.google.com/apppasswords`, and put that in. Leave the host and port
as they are.

**For anything else,** port 465 is TLS from the first byte, and `MAIL_SECURE`
defaults to `true` there; port 587 starts in the clear and is upgraded with
STARTTLS, which is what it defaults to on any other port (`MAIL_SECURE=false`).
Port 25 is not offered: it is unencrypted, and this connection carries a
password.

There is no package to install. `mailer.js` speaks SMTP over Node's own `tls`,
for the same reason passwords are hashed with Node's own scrypt rather than with
bcrypt off npm: `npm install` should fetch as little as possible on a machine
this is being set up on.

The server code in `public/Back-end/` — `server.js`, `mailer.js`, the old
`mail-password.txt` — stays on the server; only `public/Back-end/modules/` and
the `*-connection.js` files in `public/Back-end/Connections/` (the browser
scripts) are handed to a browser.

### 6. Start the server

```
npm start
```

Open http://localhost:3000 in a browser.

On startup you should see three lines:

```
Connected to MySQL database "hardware_db" on localhost.
All 36 stored procedures are loaded.
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

These five are the only accounts the database ships with; the administrator
makes any others from the Accounts screen. Only the admin account skips the
first login password change. The other four land on `change-password.html`
and pick a new password of 8 characters or more.

### Mock data

The demo data above is a handful of rows so every screen has something to
show. Section 8 of `1-RUN-FIRST-database.sql` then loads six months of
trading for a hardware shop in Nasugbu, Batangas, so the system can be tested
and evaluated against something that looks like a shop rather than against
tables with three rows in them: twenty-six more customers with credit accounts in every standing, four more
suppliers, forty more materials with stock on the shelf, eleven purchase
orders, a hundred-odd sales with their lines and payments, deliveries at
every stage, returns, stock movements, credit extension requests, alerts and
an audit trail to match.

Every row of it is the work of one of the five accounts above: the cashier
rang up every sale, the driver ran every delivery, the clerk made every stock
movement, and the manager took every credit decision. No other staff exist.

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
by role*).

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
product a line — name, category, brand, what it is sold by, price, whether
it can be sold — rather than a grid of cards, because six hundred products
read faster down a column than across a wall, and the prices sit in one
column where they can be compared. **The row is the button**: pressing a
product anywhere on its line puts one on the order, and pressing it again
puts one more. There is no Add button to aim at and no card to read first;
the line lights up on the order as it lands, and the catalog row says *2 on
order* beside the name until it is taken off. A product that has run out
says so on its line and cannot be pressed.

**Counted, measured, and sold by the box.** A bag of cement is counted, and
a press puts one on the order; nails are weighed and wire is cut, so a
product sold by the kilogram, gram, metre, litre, foot or gallon is
*measured*: the amount on its cart line is typed — *2.5* kg — as well as
stepped by a half with − / +, with what is on the shelf as the ceiling.
Which a unit is comes from its name (`MEASURED_UNITS` in
`shared/format.js`); every other unit is counted, in whole numbers.

Many things also go out in bigger sizes: nails by the sack, bulbs by the
box, cement by the pallet. Those are **selling units**, kept by the clerk
on the material's card (*Selling Units* tab — the size's name, how many of
the product's own unit it holds, and its price, or none to charge the unit
price times the count). The till reads them from the catalogue, and every
cart line whose product has sizes carries a small **unit picker** — *kg*,
*box (5 kg)*, *sack (25 kg)* — so the same product is counted in whichever
size the customer asked for. Stock is always kept in the product's own
unit: two sacks ask the shelf for fifty kilos, the ceiling on the line is
what the shelf can give in that size, and a size the shelf cannot fill even
once falls back to the unit and says so. The invoice prints what was
charged for and what left the shelf on one line — *2 sack (50 kg) x
₱1,850.00*.

Behind it: `product_units` holds the sizes, and a sale line records the
size it was sold in (`sale_items.sold_unit`, `sold_quantity`) beside
`quantity`, which stays in the product's own unit so stock, reorder points
and the reports that count units keep reading it as they always have;
`unit_price` is the price of one of whatever was sold, and `subtotal`
multiplies the two. `sp_create_sale_transaction` takes `unit` on each
line, prices it from `product_units`, and adds every line naming one
material up in the product's own unit before checking the shelf, so a sack
and a loose kilo of the same nails cannot between them sell what is not
there. The quantity columns take three decimal places, and the server adds
the sizes table and the sale-line columns on a database from before at
startup; **re-run file 2 afterwards**, because the sale procedure that
reads them comes from there. Removing a size later changes nothing already
sold: each sale line keeps its own copy.

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

**Debt payments, from the customer's card.** A sale on account is settled
later, at the counter, from **Customers Record**: press the customer's
name and, when they owe something, their card has an **Unpaid Sales** tab
listing every sale still carrying a balance — receipt, date, what is left
and when it falls due (thirty days from the sale, the same term that turns
an account to Watch), oldest first. Pressing a sale, or *Take a Payment*
in the card's foot (which opens the only sale owing at once, or the tab
when there are several), opens **Take a Payment**: the balance is filled
in, a quick-fill row offers a quarter, half or all of it, the method is
chosen, a cheque or transfer number goes in the reference box (and is
insisted on for those two), and a line under the form says what the balance
becomes before the button is pressed. The server records it through
`sp_record_credit_payment`, which refuses anything over the balance and
marks the sale *Paid* when it reaches zero. When the form closes the card
comes back with the new balance, and the credit book and a customer picked
at the till follow at once. Taking payments is still a switch in the
catalogue (`debt-payments`), so the administrator can turn it off for the
cashiers; the tab and the button then do not appear.

**The button says what pressing it does.** The checkout button's words follow
the payment method and what has been typed, so nobody books a sale to an
account thinking they took the money for it:

| The sale as it stands | The button says |
|---|---|
| paid in full at the counter (cash, cheque, e-wallet, transfer) | **Complete Sale** |
| Credit, nothing paid now | **Charge to Account** |
| Credit, part paid now | **Take Part Payment & Charge the Rest** |
| Credit, the whole amount paid now | **Complete Sale** |
| Cash on Delivery | **Place COD Order** |

It is worked out in `checkoutLabel()` in `cashier.js`, from the same totals
the order panel shows.

**A payment reference, so the money can be traced.** Money that is not handed
over in notes is only money once it clears, and it is found again by its
number. A **Reference** box appears under the payment fields for anything but
cash:

| How the money arrives | Reference |
|---|---|
| Cheque | required — the cheque number |
| Bank Transfer | required — the bank's reference for the transfer |
| GCash, PayMaya, PayPal | optional — the e-wallet's reference |
| Cash, Cash on Delivery | not asked |

On a Credit sale the part payment's own method decides it, and nothing paid now
asks for nothing. The screen refuses a cheque or a transfer with an empty box
before anything is sent, and `POST /api/sales` refuses it again whichever
screen sends it. Once the sale exists the reference is written to
`sales.reference_no` by `sp_set_sale_reference`, which never overwrites a
reference already on a sale (it is what the money is traced by; a second one
typed later would lose the first) and puts a `SALE_REFERENCE_SET` entry on the
audit trail. A reference typed against cash is not kept. The invoice prints it
on the *Reference* line.

**Bank transfers.** The shop's account — bank, account name, account number —
is kept by the administrator under **Receipt Maintenance**, in a *Bank transfer
details* box: all three, or none, because a bank with no number, or a number
with no name on it, sends a customer's money nowhere anyone can find it. The
screen and the server both hold to that, and the number has to be digits (with
spaces or dashes where the bank prints them). It is saved through
`sp_update_store_bank_details`, called only when the account actually
changed; the audit entry carries only the last four digits.

Whenever **Bank Transfer** is chosen at the till — as the sale's method, as the
part payment's method on a Credit sale, or on the *Take a Payment* card — a box
shows the bank, the account name, the account number and the amount to send,
to be read out to the customer. With no account on file it says so, and says
who can add one. The invoice prints the account too: as a record when the sale
was paid by transfer, and as the way to pay when the sale leaves a balance, with
a line asking the customer to quote the invoice number (*OR-000123*) as the
transfer reference so the money is matched to the sale when it lands.

**The customer's history is paged, not scrolled.** A customer's card at the
till and on the manager's Credit screen shows purchases beside payments; a
customer with sixty sales used to have the tables flowed sideways into pages
of the card, cut mid-table. Each table now pages on its own — six rows, a
*Previous* and *Next* under it, and *1–6 of 60 sales* between them — on a
tab of its own beside the account facts, and the card scrolls down on a
short screen rather than turning pages (`pagedTable` in
`shared/detail-modal.js`; a card marked `data-modal-scroll` opts out of the
page-turning that every other card does).

## On a phone

Every screen works on a phone, and the tables are the reason that took work.
A six-column table on a 380px screen either shrinks until nothing can be read
or scrolls sideways, which hides the figure you opened the page for.

So below 640px a table stops being a table. Each row becomes a card: the name
of the record on top, then one line per value with the name of its column
beside it, then whatever you can do to that record as a full-width button at
the bottom. Nothing has to be repeated in the markup for this — the column
names are read off the table's own headings by `labelTableCells()` in
`Back-end/modules/shared/tables.js` and stamped onto every cell as it is
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

So a new password comes from outside the signed-in screen, one of three ways
(see *When a password is lost* below): a code emailed to the person from the
sign-in page, a reset by a manager or the administrator — made the way a new
account's password is made, mailed to the address on file, every screen the
person has open signed out, and a password of their own chosen on the next
sign-in — or, when nothing else is left, a script run on the server's own
computer. The server refuses the two own-password routes whichever screen sends
them (`notOwnCredentials` in `server.js`), and the refusal names the ways
that do work.

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
itself. The database stores only a scrypt hash.

**Reset Password** on an existing account is the same machinery. Nobody types
the new password: the server makes one, mails it, ends every session the
account holds, and the person chooses their own on the next sign-in. If the
mail cannot go, the password comes back to the administrator's screen once,
as it does for a new account.

## When a password is lost

The administrator's **Reset Password** is the first answer, and it is not
always there: the administrator is off for the day, or is the one locked out.
So there are three more ways back in, each for a different gap.

### 1. "Forgot your password?" on the sign-in page

For anybody, when mail works. Under the sign-in form, **Forgot your
password?** turns the card over: type the address you sign in with, and a
six-digit code is emailed to it; type the code and a new password, and that
is your password. It is chosen by you, so it is not a temporary one.

- The code comes from `crypto.randomInt` and only its scrypt hash is kept, in
  `password_resets`. It lasts **15 minutes** and **five wrong tries**, and
  asking again retires the one before.
- An account is sent **at most one code a minute and five an hour**.
- The reply to "send me a code" is the same sentence whether or not the
  address has an account, and it is given before any mail goes, so neither
  the words nor the time taken says which addresses exist. A wrong code and
  an unknown address get the same refusal too.
- Using the code releases a sign-in hold, ends every session the account had,
  and goes on the audit trail as `PASSWORD_RESET_BY_CODE`; codes sent,
  refused and mistyped are on it as well.
- The mail has **no link**, for the same reason the first password has none
  (`passwordResetMessage()` in `mailer.js`).
- If mail is not set up, the page says so and names who can help instead.

Routes: `POST /api/password-reset/request` and
`POST /api/password-reset/confirm`, both open (nobody is signed in yet), in
`Back-end/Connections/login.js`; the page is `shared/password-reset.js`.

### 2. A manager's Staff Passwords screen

For cashiers, inventory clerks and delivery personnel, when mail does not
work or the person cannot reach it. **Staff Passwords** on the manager's menu
lists everyone in those three roles with a login, and **Reset Password** does
exactly what the administrator's does — it is the same function
(`resetStaffPassword` in `Connections/admin.js`, passed to `Connections/manager.js` rather than
copied): a generated password, emailed, shown once on the manager's screen if
the mail cannot go, every session ended, the hold released, and a new one
chosen on the next sign-in. The server refuses a Manager's or a System
Administrator's account whatever the screen sends, so one manager cannot take
over another's account or the administrator's. It is a screen in the catalogue
(`staff-passwords`), so the administrator can switch it off. Routes:
`GET /api/staff/passwords` and `POST /api/staff/:id/reset-password`.

### 3. The last resort, on the server's own computer

For when nobody can get in at all — the administrator is locked out and mail
is not set up:

```
npm run recover-password -- someone@example.com
```

It sets a temporary password on that one account, prints it **once**, marks it
to be changed on the next sign-in, releases the sign-in hold, and writes a
`RECOVER_PASSWORD` entry on the audit trail naming the computer it was run
on. It needs the `.env` the server uses, so only someone who can already read
the database password can run it. A screen still signed in on the old password
stays signed in until the server restarts; restart it to end those.

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

Figures read down their column. In a table a figure is marked `cell-num` and
set to the right in tabular figures, and `alignTableColumns()` in
`shared/tables.js` sets the heading over it to match. An amount typed into a
number box is set the same way (`input[type="number"].form-control` in
`general-ui.css`); the order's − / + quantity boxes are not form controls and
keep their centred figure.

The credit screens use the same four words everywhere: **Credit Limit**, the
most an account may owe; **Balance**, what it owes now; **Available
Balance**, what it can still take on account; and **No balance** for an
account that owes nothing. A payment's method is labelled **Payment method**,
at checkout and on *Take a Payment* alike.

## GCash and Maya by QR code

With GCash or PayMaya chosen, the till offers **Pay by QR** beside Complete
Sale (and on *Take a Payment*). The card shows a QR code holding the address of
the page the customer pays on. The customer scans it with the phone's camera
and approves the payment, and the till sees it within three seconds and
finishes the sale by itself. The server asks the payment provider again before
anything is recorded, and a payment is used once: its number becomes the
sale's reference. A code lasts 10 minutes. A failed or expired code offers
**New QR** or **Choose another method**, and nothing is recorded for it.

Every attempt is a row in `qr_payments` with how it ended (paid, failed,
expired, cancelled), and **QR Payments** lists them with the success rate: the
cashier their own, the manager everyone's. A paid code whose sale could not be
saved (an item ran out) stays paid and says *paid but sale not saved – refund
needed*.

`PAYMENT_PROVIDER` in `.env` decides who takes the money:

- `paymongo`: PayMongo, with `PAYMONGO_SECRET_KEY`. An `sk_test_` key is test
  mode (no real money) and the screens say **TEST MODE**.
- `sim`: an offline simulation served by this app, with Pay and Fail buttons
  under a **SIMULATION** banner. For a demo with no internet.

The phone opens the page at the address the server prints at start-up (or at
`HARDWARE_SITE_URL`), so it must be on the same Wi-Fi as this PC.
`node tests/paymongo-check.js` makes one PayMongo test payment and prints the
page to pay it on.

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

### The automatic one, once a day

The server backs the whole database up **once a day**, on its own, at
`BACKUP_HOUR` (2 in the morning unless `.env` says otherwise). It used to dump
the whole database after every transaction, which made a busy till lag: every
sale paid for a full copy of every table. A check runs every ten minutes and
writes the day's file once the hour has come, so a server that was asleep or
restarted at that hour catches up on its next check. The **Backup &
Recovery** screen says whether it is on, when it runs, and the last file, from
the server rather than from a sentence written into the page.

The dump streams each table from MySQL and writes it a hundred rows at a time,
so a large table is never held in memory whole.

**Old ones are deleted.** The newest `BACKUP_KEEP_DAYS` automatic files (30 by
default) are kept, and writing a new one deletes the oldest. The copy the system
takes just before a restore counts as an automatic one too. If the database is
missing stored procedures, the backup is still written but nothing is deleted,
so the last good file is never rotated away.

A successful daily backup is not written to the audit trail; a *failure* is,
once, and is said on the screen in plain words.

On a cloud host, set `TZ=Asia/Manila` so the hour is the shop's, and point
`HARDWARE_BACKUP_DIR` at a disk that survives a redeploy. The folder's path is
never sent to the browser. On Vercel, which has no lasting disk, backups are
kept in the database instead (`HARDWARE_BACKUP_STORE=database`) and the daily
one is taken by Vercel Cron; see [DEPLOY-VERCEL-AIVEN.md](DEPLOY-VERCEL-AIVEN.md).

A restore and the backup never overlap. A restore drops and rebuilds every table
in turn, and a backup taken then would be a dump of a half-restored database,
so the backup stands down while a restore is running.

### The one you take yourself

**Run Backup Now** writes a file named `hardware_db_backup_...`. Those are
decisions — taken before a schema change, at the end of a day — and they are
**never rotated away**. Nothing automatic can delete something an administrator
chose to keep. Because they are kept, there can be at most `BACKUP_MANUAL_LIMIT`
of them (20 by default); at the limit, Run Backup Now asks for an old one to be
deleted first.

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
a minute (it ran on a clock then), and each one rotated an older file out.
Sixteen went into the folder before anybody noticed. At the steady state of 60
files, **one hour of that would have rotated out every last backup that still
had the procedures in it** — sixty flawless copies of a broken database and no
way back.

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

## Every column, all the time

A table shows every one of its columns. There is no switch that hides some
of them behind a *Show more columns* button: a column that is on the screen
at all is worth reading without a press first, and the screen, the
spreadsheet export and the print all carry the same columns. A row that
opens a popup of its own still does, and the popup carries everything.

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

The whole of it lives in `Back-end/modules/shared/data-panel.js`, so a table
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

## Access control: screens by role

A role decides what somebody does, and each role's menu is written into its
own page: a manager's page lists the manager's screens, a cashier's the
cashier's. That is the right default and it was rigid. A cashier who also
loads the van could not be shown the delivery schedule without being made a
manager, and a clerk who should not be resolving returns kept the screen
because every clerk did.

So every screen is now an entry in a catalogue (`FEATURES` in `server.js`):
its name, the roles whose page can draw it, the roles that hold it by role,
and the routes it is made of. **Access Control**, one link on the
administrator's menu, is that catalogue in two columns: the **roles down
the left** — one button each, saying how many of its screens are on, with
an amber mark while it carries unsaved changes — and on the **right the
picked role's screens as a list of switches**, grouped under their module
(Point of Sale, Credit, Inventory…), every row the same three columns —
the switch, the screen's name and what it does, and a word saying what the
switch means for the role — so the switches sit on one line down the page.
Every role's switches are drawn and all but the picked role's hidden, so a
change made under the cashiers survives a look at the clerks before Save;
on a narrow screen the roles sit above the switches as a row. The
administrator can:

- **switch a screen off** for a role that holds it by role. Refunds off the
  cashiers, say, or Adjustment History off the clerks.
- **switch a screen on** for a role whose page can draw it but does not hold
  it by role. Today that is the **Delivery Schedule** — the deliveries still
  to go out, under Overdue, Today, Tomorrow and Later — which the manager
  holds by role and any of the other three can be given.

A screen a role's dashboard cannot draw is not on that role's line at all:
a menu item with nothing behind it is a dead end, not a feature. The System
Administrator is not in the dropdown; the administrator's screens are the
administrator's by role and nobody grants them anything. The word beside
each switch says what it means for that role — *on by default*, *switched
on*, *switched off* — and Save reads the changes back first, in a card that
turns crimson when a screen is being taken away, because somebody may be
standing in front of it.

**Where it shows.** Every menu item on the four staff dashboards names the
screen it opens (`data-feature="credit-requests"`), and
`shared/features.js` asks `/api/me/features` which screens the role holds
and hides or unhides the items to match — on arrival, and again over the live
channel the moment a switch is thrown, with no reload. A heading whose
screens have all been taken away goes with them, and the strip of tabs
across the top follows the menu. If the screen somebody is looking at is
switched off while they are on it, their page goes back to its first screen
and says why. The Delivery Schedule is drawn by `shared/delivery-schedule.js`
rather than written into a page, because a screen that can land on any page
has to be able to draw itself on any page; its menu item is in each page's
markup, hidden until the role has it.

**How it is enforced.** Not by the menu. Each screen lists the routes it is
made of, and the access hook in `server.js` reads them after `ACCESS_RULES`
has had its say:

- a route is **refused once every screen using it is switched off** for the
  role. A route two screens share — `/api/stocks` under both Reorder Alerts
  and Stocks Overview — is not refused while either is still held.
- a route the role table would refuse is **allowed when the role holds a
  screen that needs it by grant** — an override, not a default. A screen held
  by role has its routes in the role table already, and a default never
  widens them: the cashier's Delivery Tracking is read-only by role, and
  granting the cashiers nothing new leaves it so. A clerk given the schedule
  may read `/api/deliveries` and still may not move a delivery along.

The overrides are one row each in `role_feature_permissions`, and only the
administrator's changes are rows — set a switch back to what the page has and
the row is deleted, so an empty table means every menu is exactly what its
page says. Read on every request rather than kept on the session, so a
revocation bites on the very next call; cached in memory between writes,
because it is a few rows. Every switch thrown is on the audit trail as
`GRANT_SCREEN` or `REVOKE_SCREEN`, filterable as *Access granted / revoked*.
The table is created by the server at startup on a database from before it
existed.

Making another screen grantable means drawing it by script the way the
schedule is (so any page can carry it), giving each page a hidden menu item
for it, and listing the roles whose pages have one under `available` in the
catalogue. A screen that is only ever on one page needs none of that: its
entry in the catalogue is what lets the administrator switch it off.

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

The **Income** entry in the manager's menu opens a breakdown over any
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

**Records** works the same way: one screen holding one table at a time — five
kinds of record — chosen from the entry in the menu, which folds open under
the heading the way Income does. There is no second control: the card is
headed with the kind of record showing, and the menu is beside it.

**Reports** is the manager's first screen, the one that opens on signing in
and the one the brand corner goes back to. All four reports — Payment
Methods, Receivables, Repeat Customers, Staff Performance — sit down one page,
each a card of its own with its own Load Data button, so opening the page
fetches nothing and a report is read only when it is asked for. The list
under **Reports** in the menu does not swap the screen; it scrolls to that
report and marks the entry.

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

### The price is the manager's

The clerk counts and the manager prices. A product's card on the Stock
Report has a **Change Price** button on its Pricing tab: the new figure is
typed, read back with the percentage it moves by and what the stock value
becomes (a jump of half or more turns the card crimson, because that is
more often a slipped decimal than a decision), and saved through
`PUT /api/stocks/:id/price`, manager-only and on the audit trail as
`UPDATE_PRICE`. It reaches the till from the next sale on; sales already
rung up keep the price on their lines, and a selling size with a price of
its own keeps that too, while one priced from the unit follows the new
figure by itself.

## Purchase orders: raised and counted in at the door, checked upstairs

A purchase order is raised on the clerk's page: name the supplier, list the
materials, send it, and the printed order opens ready to hand to a company
that has no login to this system. The supplier is typed rather than picked,
and so is each material, because a purchase order is how a shop buys
something it does not have yet, often from somebody it has not bought from
before.

Buying is still a manager's decision, so the order waits for the manager to
confirm or decline it. That is all the manager's page does with it: check the
order, confirm it or send it back with a reason. There is no count sheet on
the manager's page, and the server refuses a manager who calls the receive
route anyway.

**Confirming is placing the order.** The moment the manager confirms it, the
server emails the order to the supplier at the address on the supplier's
record: plain text, with the order number to quote, the date, where it is to be
delivered, every line (quantity, unit, unit cost, line cost) and the total
(`purchaseOrderMessage()` in `mailer.js`). The confirm dialog says where it
is going before the button is pressed. The decision never waits on the mail:
if the supplier has no address on file, mail is not set up, or the mail server
refuses it, the order is still confirmed and the manager is told, in a card
that stays until it is closed, to print the order and send it. Either way the
audit trail says which (`PURCHASE_ORDER_SENT` or `PURCHASE_ORDER_NOT_SENT`),
and the route answers with `supplierNotified` and `supplierNote`.

Once confirmed, receiving is the clerk's: the count sheet — what was ordered
on the left, what came off the lorry typed on the right — books the goods
onto the shelf and closes the order. An order the manager has not confirmed
yet cannot be received, and the server refuses that too.

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

### The late-payment penalty

A credit sale is due thirty days after it is rung up. Past that, it costs the
customer: **1 to 3 percent a month of the goods still unpaid**, and the
default is **3**. The first month is charged the day after the due date and
another every thirty days the sale stays unpaid; a part of a month counts as
a month, so a sale forty days overdue has been charged twice. It is the
goods that are charged on — the sale less what has been paid — never the
penalty itself, and a payment comes off the goods first, so a sale whose
goods are paid but whose penalty is not stops growing.

The charge is made by the database (`sp_apply_late_penalties`), which the
server runs at start-up and every hour after. Each sale keeps the rate it was
charged at, how many months have been charged, what they add up to and when
the last one was, so the charge can be read back later whatever the policy
becomes; the manager and the cashier are each told of every charge under
*Late Penalty* in their alerts, and the audit trail records it. The penalty
sits on the sale as `amount_due` — the bill with the penalty on it — and
**every balance in the system reads that**: the credit book, the account
card, the cashier's balances-due sheet and the payment it takes, the receipt
reprinted later, the income figures and the standing rules. The sale itself,
`final_amount`, is untouched, so the sales figures are still the sales.

**The rate is the manager's.** The strip above the manager's credit book says
the shop's rate in force and what is owed in penalties; *Change the rate*
sets another, anywhere from 1 to 3, with a worked example before it is
saved. A change applies from the next month charged and never rewrites a
month already charged. An account can also be given **a rate of its own** on
its credit terms, beside the limit and the standing override — a loyal
customer at 1 percent while the shop stays at 3 — and blank there means the
shop's rate. The cashier reads the rate and sees the penalties but cannot set
either; the server refuses the route to anyone but a manager.

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

**Who decides it depends on where the goods are.** A damage report from the
stockroom is filed by the person holding the goods, so the clerk says where
they go as they file it. A refund at the counter is different: the cashier
takes the item back and gives the money, but is not the one to judge whether
it can be sold again. So a refund is filed **awaiting inspection** — nothing
moves on the stock count, the goods are set aside, and the clerk is told.
On the clerk's Returned Items screen the *To inspect* chip counts them; the
report card asks the one question, *can it be sold again?*, with a line for
what was found, and the answer closes the report: **sellable** puts it back
on the shelf and the count goes up, **not sellable** writes it off (the sale
already took it off the count, so nothing moves). The report keeps who
inspected it, when, and what they found; the manager and the counter are
both told the verdict. The server ignores any disposition a cashier sends,
so the counter cannot decide it by accident.

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
- **Anything that is not a table can subscribe too.** The delivery schedule
  listens to the same scopes through `onLiveChange`, so it re-reads itself
  when a sale or a delivery lands on another machine. A background refresh
  that fails leaves the last good figures where they are rather than blanking
  them.

A browser that was disconnected long enough to fall behind the server's change
log is told to reload rather than shown a half-updated screen.

There is one hook on the server, not fifty: every write already passes through
the access-control middleware, so that is where a change is announced from. A
new route is covered the day it is written.

## Project layout

```
launch/launch.json          starts the app from the editor (node public/Back-end/server.js)
tests/                      automated checks (not used by the app; see tests/ui/stub.js)
public/
  Front-end/                what the user sees: the pages and their styles
    Login.html, change-password.html
    system.html               System Administrator dashboard
    manager.html              Manager page
    inventory-dashboard.html  Inventory Clerk dashboard
    cashier-dashboard.html    Cashier dashboard
    delivery.html             Delivery Personnel page

    css/
      general-ui.css          colours, type, the shell, and every component
                              two or more roles share
      responsive.css          the phone layout, for every role
      purchase-orders.css     the order form, the printed order and the count
                              sheet, on the manager's page and the clerk's
      modules/                one stylesheet per role

  Back-end/                 every JavaScript file
    server.js               Express, sessions, the audit trail, live sync,
                            the access table, screens by role
    passwords.js            hashing and making passwords
    mailer.js               sending email (SMTP)
    recover-password.js     npm run recover-password: the last resort, run on
                            the server's own computer

    Connections/            both halves of every connection, side by side
      database.js                     the MySQL connection (settings from .env)
      login.js                        server: sign in, sign out, heartbeat, passwords
      shared-connection.js            browser: calls used by more than one kind of user
      admin.js                        server: System Administrator routes
      admin-connection.js             browser: System Administrator calls
      manager.js                      server: Manager routes
      manager-connection.js           browser: Manager calls
      cashier.js                      server: Cashier routes
      cashier-connection.js           browser: Cashier calls
      inventory-clerk.js              server: Inventory Clerk routes
      inventory-clerk-connection.js   browser: Inventory Clerk calls
      delivery.js                     server: Delivery Personnel routes
      delivery-connection.js          browser: Delivery Personnel calls
                            (every browser function that talks to the server
                            starts with "api"; only the *-connection.js files
                            are ever sent to a browser)

    modules/                the page scripts, run in the browser
      shared/               screen code every page shares (menus, tables,
                            popups, sign-in, notifications, purchase orders,
                            icons)
      system-admin.js       system.html
      manager.js            manager.html
      inventory-clerk.js    inventory-dashboard.html
      cashier.js            cashier-dashboard.html
      delivery-personnel.js delivery.html

  vendor/bootstrap/         Bootstrap 5, kept in the project, no internet needed
  vendor/bootstrap-icons/   Bootstrap Icons (the font and its stylesheet), also kept here;
                            shared/icons.js puts them on buttons, tabs, titles and cards
  database/
    0-READ-ME-FIRST.md                    how to run the two files below
    1-RUN-FIRST-database.sql              the tables and the demo data
    2-RUN-SECOND-stored-procedures.sql    the views and stored procedures
backups/                    dated .sql backups
```

### Which address serves which folder

The pages keep short addresses; server.js maps them onto the folders:

```
/Login.html, /css/...   ->  public/Front-end/
/modules/...            ->  public/Back-end/modules/
/connections/*-connection.js -> public/Back-end/Connections/ (browser files only)
/vendor/...             ->  public/vendor/
```

Nothing else is served, so the server code in `public/Back-end/` and the SQL
files in `public/database/` never reach a browser.

### Which files a page loads

Every page loads the same shared set, then the files for its own role:

```
css:  general-ui.css  ->  responsive.css  ->  modules/<role>.css
js:   modules/shared/*  ->  connections/shared-connection.js
      ->  connections/<role>-connection.js  ->  modules/<role>.js
```

A screen never writes a server address itself. It calls a function from
its connection file, for example `apiGetDeliveries()`, and that function
holds the address (`/api/deliveries`). To see what a screen sends to the
server, open the connection file of that role.

## Notes

- Express serves only `Front-end/`, `Back-end/modules/`, the
  `*-connection.js` files in `Back-end/Connections/`, and `vendor/`.
  The server code and `database/` are never handed out.
- Passwords are stored as scrypt hashes, never as readable text. A database
  restored from an older backup that still holds readable passwords is upgraded
  automatically the first time each person signs in.
- Every API route checks the session cookie and the role behind it. Nothing the
  browser sends decides what it is allowed to do.
