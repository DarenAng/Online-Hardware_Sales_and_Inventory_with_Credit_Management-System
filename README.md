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
table and no row, so it can be re-run on its own at any time.

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

### 5. Start the server

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
a click and offers three things:

- **View my credentials** — everything the system holds about you.
- **Edit my credentials** — first name, middle initial, last name, phone and
  the email you sign in with. Your role is not editable here; only the system
  administrator moves people between roles.
- **Change my password** — your current password is asked for first, so an
  unattended screen cannot be used to lock you out of your own account.

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

## Staff names and the middle initial

Two people may share a first and a last name. The middle initial is what tells
them apart, and it appears everywhere a staff name is shown: the directory, the
receipt, the audit trail and every report.

An email address is a different matter. It is the username, MySQL enforces it as
unique, and two accounts cannot share one. If the email is already taken the
create screen says so in plain words and asks for a different one.

## Backup and recovery

The System Administrator's **Backup & Recovery** screen writes the whole system
to one dated `.sql` file: every table, every row, both views and all eighteen
stored procedures. Files are named after the moment they were taken —
`hardware_db_backup_2026-09-04_1407.sql` — and are kept in the `backups/` folder
in the project, so the folder builds up a history instead of one file being
overwritten.

Each backup in the list can be downloaded, restored, or deleted. A backup taken
here also opens and runs in MySQL Workbench, which is what makes it a real
backup rather than an export only this application understands. Restoring
replaces everything currently in the system, so the screen asks first.

## Tables that wait to be asked

Every table in the system starts closed. It shows a search box, whatever
filters it offers, and a **Load Data** button, and it queries the database when
somebody presses one of them and not before.

This is not a loading trick. Five dashboards each fetching four or five tables
on open is twenty queries fired for the one screen a person actually wanted,
and the person who opened the page to look up a single customer waited for all
of them.

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

The **Total Income** card on the manager's dashboard opens a breakdown over any
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
- **A lost connection is visible.** The dot in the top bar reads Live, Offline
  or Behind, because a screen that has quietly stopped hearing about changes
  looks exactly like a screen where nothing has changed, and the difference
  matters when the figure is stock on hand.

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
backups/                    dated .sql backups written by the admin screen
tests/                      the checks described below
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

That rebuilds the database, restarts the server, runs `tests/smoke.js` (every
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
