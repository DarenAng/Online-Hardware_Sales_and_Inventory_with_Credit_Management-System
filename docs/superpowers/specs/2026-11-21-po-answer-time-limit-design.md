# Purchase order: 12-hour answer limit and shop cancel

Approved by the user on 2026-11-21.

## Why

When an order is sent to a supplier, the supplier answers through a link (email, or the QR code on the
printed copy). The link never expires and the shop cannot take a sent order back. If the supplier stays
silent and the shop orders the same goods from another supplier, the first supplier can still accept
later, and two deliveries end up coming in.

## Goals

- The supplier's link accepts an answer for 12 hours from `purchase_orders.supplier_sent_at`
  (set by both Email to supplier and Mark as sent).
- After 12 hours without an answer the order closes as **No Answer**: it leaves "Sent to Supplier",
  never reaches Receive Deliveries, and the link refuses to accept or decline.
- The shop can **Cancel order** while the supplier has not answered yet (sent or not yet sent, but approved),
  with a required reason. The order becomes **Cancelled** and the link stops working at once.
- A late supplier sees why: expired at <time> without an answer, or cancelled by the shop; contact the shop.
- While waiting, the order popup shows "Answer by" with the deadline.
- Cancel gets its own Access Control switch, "Cancel Purchase Orders", default Manager and Inventory Clerk.

## Non-goals

- No limit on the shortage-notice link (Incomplete orders).
- No "Send again" button; to try the same supplier again the clerk raises a new order.
- No cancellation email to the supplier.
- No cancel after the supplier has accepted (goods may be on the way; phone the supplier).
- The manager's Decline at approval keeps showing as Declined.

## Approaches

- **A. Close as No Answer after 12 hours (picked).** Simple; nothing can arrive late.
- B. Same, plus "Send again" for another 12 hours. More buttons and cases; the user did not want it.
- Shop cancel added at the user's request on top of A.

## Builder's calls

- How the 12 hours is enforced (checked when the supplier answers, and the order is closed when orders
  are read, so no timer is needed), and how No Answer / Cancelled are stored so they stay apart from the
  manager's Decline.
- The 12 hours is one constant in the backend.
- Follow the project rules: plain code, no helper notes on screens, status labels as dot + text,
  table rows open the popup (buttons go in the popup).
