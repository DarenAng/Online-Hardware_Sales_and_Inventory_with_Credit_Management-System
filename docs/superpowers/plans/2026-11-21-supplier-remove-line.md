# Supplier Remove Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A supplier can remove lines they cannot supply before accepting, and the shop sees which lines were removed.

**Architecture:** Removed lines move from `purchase_order_items` to a new `purchase_order_removed_items` table inside the accept transaction, so the existing order, receive and total logic is untouched. The supplier page sends `removed` ids along with `accept`. The staff popup reads the removed lines through a new GET route.

**Tech Stack:** Node.js + Express, MySQL 8, plain browser JS.

**Spec:** `docs/superpowers/specs/2026-11-21-supplier-remove-line-design.md`

## Global Constraints
- Exact texts:
  - button **Remove**
  - line state **Not available**
  - button **Undo**
  - last-line error "Keep at least one line, or decline the order."
  - popup heading **Removed by supplier**
- Don't change the PDF, declining, or quantities.
- Plain readable code, short comments, no helper sentences on screens, no buttons in table rows.
- Never touch the live `hardware_db`. Test on `hardware_db_test` (see shared context).
- **Do not commit.** The working tree already holds uncommitted user-facing changes in `purchase-orders.js` and `modals.js`. Leave them as they are and don't revert them.

## Review Focus
- **A removed line has its price edited too.** The price change is ignored for that line, and the line moves to the removed table.
- **Every line removed.** The server returns 400 with the last-line text, even if the page is bypassed.
- **Removed ids on a decline.** Ignored; nothing is removed.
- **Removed ids not on this order, or repeated.** 400 for an id that isn't on the order. A repeated id counts once.
- **A removed line has unit_cost 0 (unpriced).** The "Enter a price above zero" check skips removed lines.
- **The discount must be less than the total.** It's checked against the total after removal.

---

### Task 1: Server

**Files:**
- `public/backend/database/migrations.js`: add `migrateRemovedItems()` at the end of the migrateDatabase list.
- `public/backend/routes/inventory-clerk.js`: the respond route, supplierView/readOrderDocument, the accept notification text, a new GET route, and `removed_count` in the GET `/api/purchase-orders` list.
- `public/backend/access-control.js` and `public/backend/features.js`: the new GET route gets the same roles and features as `GET /api/purchase-orders/:id/items`. Add it to every feature entry that lists the items route.

**Interfaces:**
- Table `purchase_order_removed_items`, created with CREATE TABLE IF NOT EXISTS:
  - `removed_item_id` INT AUTO_INCREMENT PK
  - `po_id` INT NOT NULL, FK `purchase_orders` ON DELETE CASCADE ON UPDATE CASCADE
  - `product_id` INT NOT NULL, FK `products` ON DELETE RESTRICT ON UPDATE CASCADE
  - `quantity` INT NOT NULL
  - `unit_cost` DECIMAL(12,4) NOT NULL
  - `pack_name` VARCHAR(20) NULL, `pack_size` DECIMAL(12,3) NULL, `pack_count` DECIMAL(12,3) NULL
  - `line_description` VARCHAR(255) NULL
  - `removed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
- POST `/api/supplier-order/:code/respond` accepts `removed: number[]`, used only when `accept === true`.
  - Validation:
    - every id must be a `po_item_id` on the order, else 400 "A line was removed that is not on this order. Reload the page and try again."
    - repeated ids count once
    - if every line is removed: 400 "Keep at least one line, or decline the order."
    - price entries for removed lines are ignored
    - the unpriced-line check and the order total and discount checks use only the remaining lines
  - In the existing accept transaction, after the guarded UPDATE succeeds, for each removed line run INSERT INTO `purchase_order_removed_items` (copying the columns above from `purchase_order_items`), then DELETE that `purchase_order_items` row.
  - Notification and audit text: add " They removed " + N + " line(s) they cannot supply: " + names joined by "; " + "." to the accepted message.
- GET `/api/purchase-orders/:poId/removed-items` returns `[{ product_id, product_name, unit_name, quantity, unit_cost, pack_name, pack_size, pack_count, removed_at }]`. Join products and units the way the items route does.
- The GET `/api/purchase-orders` list rows gain `removed_count` (a subquery count).
- `supplierView(document)` gains `removed: [{ product_name, quantity, unit_name, pack_name, pack_size, pack_count }]`. `readOrderDocument` selects them.

- [ ] Write failing tests in `po-limit.test.js` (keep the existing 21 passing):
  - `remove_line_on_accept`: accept with removed=[one line], so that row is gone from `purchase_order_items` and present in `purchase_order_removed_items` with the same `quantity`/`unit_cost`. The list `removed_count` is 1. The GET removed-items route returns it. The notification or audit text contains the product name.
  - `remove_all_refused`: removing every line returns 400 with the last-line text.
  - `remove_unknown_refused`: 400.
  - `remove_ignored_on_decline`: decline with removed ids returns 200 and nothing is removed.
  - `removed_line_price_ignored`: a price edit plus removal of the same line returns 200, and the removed row keeps the original `unit_cost`.
  - `removed_unpriced_ok`: a line with `unit_cost` 0 that is removed doesn't trigger "Enter a price".
  - `discount_checked_after_removal`: a discount ≥ the remaining total returns 400.
  - `removed_route_roles`: the cashier gets 403, the clerk 200.
- [ ] Run (RED), implement, run (GREEN), self-review.

### Task 2: Supplier page

**Files:** `public/frontend/scripts/supplier-order.js` (draft state, line render, totals, submit, receipt) and `public/frontend/css/pages/supplier-order.css` (removed-line style).

- [ ] `draft.removed = {}` (id → true).
  - Each quote line gets a **Remove** button beside **Edit price**.
  - A removed line: name and amounts crossed out, the text **Not available**, an **Undo** button instead of Remove, and Edit price hidden.
  - The totals and discount math skip removed lines.
  - Removing the last remaining line shows "Keep at least one line, or decline the order." through the page's existing error display.
  - Submit sends `removed: [ids]` with accept, and leaves removed lines out of `prices`.
  - The receipt after accepting lists `view.removed` lines crossed out with **Not available**.
- [ ] `node --check`, plus an API check that the page's request shape matches Task 1. The controller does the browser check.

### Task 3: Staff popup

**Files:** `public/frontend/connections/shared-connection.js` (`apiGetPurchaseOrderRemovedItems(poId)`), `public/frontend/scripts/shared/purchase-orders.js` (`openPurchaseOrderDetail`).

- [ ] When `Number(po.removed_count) > 0`, fetch the removed lines and render, under Ordered Items:
  - a `<h4 class="detail-subhead">Removed by supplier</h4>`
  - a `detailTable` with Material ID, Material name, Qty, Unit Cost, using the same helpers as Ordered Items, numbers right-aligned
- [ ] `node --check`. The controller does the browser check.
