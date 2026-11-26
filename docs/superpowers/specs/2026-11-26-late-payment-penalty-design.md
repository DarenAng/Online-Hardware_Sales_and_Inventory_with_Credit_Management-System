# Late Payment Penalty — design (short)

## Why
The store wants customers who pay a credit sale late to be charged a penalty, with the rate set by the
manager and written on the customer's terms (card back and printed Credit Terms and Conditions).

## What exists today
- Database already has it: `store_settings.penalty_rate` (1–3, default 3), `sales.penalty_rate /
  penalty_months / penalty_amount / penalty_applied_at`, `sp_set_penalty_policy`, `sp_apply_late_penalties`
  (charges rate % of what is still unpaid, once for every 30 days past the due date, and sends a
  "Late Penalty" notification to manager and cashier).
- Receipts, statements and the customer portal already show a "Late penalty" line.
- Commit 02a30ec (Nov 14) removed the screen that set the rate and the job that charged it, so nothing runs.

## Decisions (user)
- Penalties are charged automatically.
- Sales already overdue are charged for the months they already missed on the first run.
- Rate and credit policy are maintained on one page.

## Approach
One sensible way: switch the existing database code back on rather than build a new one.
Building a new penalty engine would duplicate columns and display code that already work.

## Design
1. **Credit Maintenance page** (Policy Maintenance): a new "Late Payment Penalty" card above the
   Credit Policy card, like the Loyalty Discount card. One field, "Penalty rate, percent a month"
   (1 to 3, left-aligned), and a Save button. The card-back preview updates as it is typed.
2. **Terms**: the Credit Policy section on the card back and the printed Credit Terms and Conditions get a
   line built from the rate, e.g. "A late payment is charged 3% a month of the unpaid balance, for each
   month past the due date." It is added automatically, not typed, so it always matches the saved rate.
   The printed page's "The credit account" table also gets a "Late payment" row.
3. **Charging**: the late-payment sweep (`sp_apply_late_penalties`) runs when the server starts, every
   hour while it runs, and in the Vercel daily cron (`/api/cron/daily`). The first run back-charges
   missed months (the procedure does this already, since `penalty_months` is 0 on every sale).
4. **API**: `GET` / `PUT /api/credit/penalty-policy` (manager), with a line in `access-control.js`
   and its own Access Control switch in `features.js`.
5. **Rate changes** apply to months charged from then on; penalties already added stay as they are.

## Non-goals
- Per-customer penalty rates (the column stays; none are set).
- Waiving or editing a penalty by hand.
- Any change to the credit interest (still charged once by the cashier on the sale).

## Left to the builder
- Exact wording of labels and the saved message, kept short (no helper sentences).
