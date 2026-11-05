# Receive Deliveries and shortages

Date: 2026-11-05.

## Why

Feedback:
- Receiving a purchase order is buried in Stock Adjustment. It needs its own sidebar item.
- That screen should show any shortage.
- A short delivery must not close the PO. The supplier is told what is missing, with the
  quantity and the amount.

Owner's choice: the supplier sends the rest later, on the same PO.

## Flow

1. **New sidebar item "Receive Deliveries"** (clerk). It has its own access switch,
   `po-receiving`, "Receive Deliveries", on for clerks.
   - It lists the purchase orders that are **Out for Delivery** or **Incomplete**, with
     Arrives and Late as on the PO list.
   - Clicking a row opens the receive form.
2. **Receive form**, kept simple, one row per line still owed:
   Material · **Expected** · **Arrived** (input, starts at Expected) · **Short**.
   - Expected is what is still owed. On the first delivery that is the ordered quantity; on a
     later delivery it is only the rest.
   - Short shows the quantity and peso amount together, worked out as the clerk types, or `—`.
   - "Total short" is shown at the bottom only when something is short.
   - The clerk can still add an item that arrived but was not ordered (as today).
3. **Saving:**
   - Arrived quantities go into stock (stock movement "Received on PO-…").
   - If nothing is still owed, the PO is **Received** and closed.
   - If something is still owed, the PO becomes **Incomplete**, not closed, and:
     - The supplier is emailed a **shortage notice**: each missing item, the quantity short,
       the unit price, the amount, and the total. It carries the same answer link/QR as the order.
     - The manager and the clerk get a notification.
4. **The supplier answers on their order page:**
   - **"I will deliver the rest"** plus a date. Arrives shows the new date and the PO stays
     Incomplete. When the rest comes in, the clerk receives it on the same PO (step 2 again).
   - **"I cannot deliver the rest"** plus a reason. The PO closes as **Received, with
     balance**. Only what arrived is paid for, because the order cost already counts received
     quantities only.
   - Manager and clerk are notified of the answer.
5. **Incomplete PO popup:** an Ordered / Received / Still owed table, the shortage amount, and
   the supplier's answer.
   - Clerk buttons: Receive Delivery, Email Shortage Again, Print Shortage Notice.
   - Manager button: **Close with Shortage**, for when the supplier never answers. It needs a reason.
6. **Stock Adjustment** no longer lists purchase orders under Reference. It keeps returns and
   manual counts.
7. **PO stages** become: For Approval, To Send, Sent to Supplier, Out for Delivery,
   **Incomplete**, Received, Declined. This applies to the filter, the badges and the PDF wording.

## Data (my calls)

- `purchase_orders.status` gains the value `Incomplete`.
- New columns, added by a startup migration:
  - `purchase_orders.shortage_sent_at`
  - `shortage_response` (`Will deliver` / `Cannot deliver`)
  - `shortage_responded_at`
  - `shortage_note`
- The new arrival date reuses `supplier_ship_date`.
- Receiving more than once: the ordered lines are copied to `purchase_order_ordered_items` on the
  first receipt only. Each receipt adds to the received quantity instead of replacing it.
- `sp_receive_purchase_order` changes to allow this. It is reinstalled through the `newestWords`
  marker. No table rows are rewritten.

## Not changing

- Approval, auto-email, To Send, and the supplier's first accept/decline.
- Returns, damage reports, and the existing Missing reports.

## Approaches considered

- **Chosen: the same PO stays open as Incomplete** until the rest arrives or the supplier says
  they cannot deliver. One PO tells the whole story.
- Close it and raise a new PO for the rest: rejected. The owner wants the PO kept open, and
  the shortage would be split across two orders.
- Clerk decides with no supplier reply: rejected by the owner.
