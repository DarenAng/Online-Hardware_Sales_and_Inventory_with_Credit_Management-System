# Simpler purchase orders

Date: 2026-11-04. Save point before this work: tag `rollback-2026-11-04`.

## Why

A purchase order can be in 7 states today, and the arrival date the supplier gives is hidden in the
popup. The owner wants to see at a glance: did the supplier accept, when does it arrive (it is
"out for delivery"), and how do we receive it. The manager only watches and approves; the
inventory clerk does the work. Both see Out for Delivery.

## Stages (what both roles see)

| Stage | When | Who acts |
|---|---|---|
| For Approval | clerk raised it (`status = 'For Approval'`) | manager: Approve / Decline |
| To Send | approved, not sent (`Pending`, no `supplier_sent_at`, no answer). Only when the auto-email could not go out | clerk: Print, Email to Supplier, Mark as Sent |
| Sent to Supplier | `Pending`, `supplier_sent_at` set, no answer | nobody (waits for supplier) |
| Out for Delivery | `Pending`, `supplier_response = 'Accepted'` | clerk: Receive Delivery |
| Received | `status = 'Received'` (+ "With balance" if short) | nobody |
| Declined | `Cancelled` (manager) or `supplier_response = 'Declined'` | nobody; popup says who and why |

No database change. The stage is still worked out from the existing columns (`poStage`).

## Changes

1. **Auto-send on approval.** When the manager approves, the server emails the order to the
   supplier right away (same email, PDF and accept link as the clerk's "Email to Supplier").
   If the supplier has no email, mail is not set up, or sending fails, the order is still approved
   and stays **To Send**; the reply message says why. The clerk then prints/emails it, or uses
   **Mark as Sent** after handing over a printed copy.
2. **Arrives column** in the purchase order list (clerk and manager): the supplier's delivery date
   (`supplier_ship_date`) for Out for Delivery orders, with a **Late** label when that date is before
   today. Every other stage shows `--`. Dates are left-aligned.
3. **Popup.** "Delivery Schedule" is renamed **Arrives**. Out for Delivery orders give the clerk a
   **Receive Delivery** button. It opens Stock Adjustment with that order already picked, so the
   clerk only changes the quantities that came short.
4. **Status filter** on both screens lists the 6 stages above.
5. **Needs-attention rows**: manager, For Approval. Clerk, To Send and Out for Delivery.
6. The printed/PDF order uses the same stage names.

## Not changing

- The supplier's own accept/decline page.
- How receiving counts stock, short deliveries, balances and reports.
- Reports and the activity log.

## Approaches considered

- **Chosen: keep the data and change only how it is grouped and shown**, plus auto-send. This is the
  smallest change and needs no database migration.
- Add new status values to the database: more work and a migration for Aiven, with no gain for the user.
- Bring back the old separate Receive Delivery panel: it is orphaned code. Stock Adjustment already
  receives orders correctly, so the button goes there.
