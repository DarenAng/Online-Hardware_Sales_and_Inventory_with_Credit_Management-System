# Supplier can remove a line they cannot supply

Approved by the user on 2026-11-21.

## Why
A supplier may have some items on a purchase order but not others. Today they can only accept the whole order or decline it all.

## Goals
- On the supplier page (`supplier-order.html`, quote step), each line has a **Remove** button next to **Edit price**. A removed line shows crossed out with **Not available** and an **Undo** button. The order total leaves it out.
- At least one line must stay. If the supplier tries to remove the last one: "Keep at least one line, or decline the order."
- When they accept, the removed lines come off the order. Receive Deliveries, the order totals and receiving only count what is left.
- The shop is told. The "accepted" notification names the removed lines. The staff PO popup shows a **Removed by supplier** list under Ordered Items.
- After accepting, the supplier's own receipt view also lists the removed lines as **Not available**.

## Non-goals
- No lowering a line's quantity. Remove is whole-line only.
- Removing a line plays no part in declining.
- The printed PDF does not change.

## Approach (builder's notes)
- A removed line is moved out of `purchase_order_items` into a new table, `purchase_order_removed_items`, in the same transaction as the accept. All existing order, receive and total logic then works unchanged on the remaining lines.
- The answer request gains `removed: [po_item_id, ...]`, which is accepted only together with `accept: true`.
- Plain code, short comments, no helper sentences on screens beyond the texts above.
