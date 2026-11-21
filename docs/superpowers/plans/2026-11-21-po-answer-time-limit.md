# Purchase Order 12-Hour Answer Limit and Shop Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A supplier's link stops accepting an answer 12 hours after the order was sent (the order closes as No Answer), and the shop can cancel an order the supplier has not answered.

**Architecture:** Both outcomes set `purchase_orders.status = 'Cancelled'` (so every existing "still open" check already excludes them) plus a new `closed_as` column that tells them apart from the manager's Decline. Expiry needs no timer: a small `closeUnansweredOrders()` UPDATE runs before the order list, the supplier page and the supplier's answer are read, and the answer UPDATE itself refuses late answers. All times use MySQL `NOW()`.

**Tech Stack:** Node.js + Express, MySQL 8 (`mysql2`), plain browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-11-21-po-answer-time-limit-design.md`

## Global Constraints

- Limit is exactly 12 hours from `supplier_sent_at`: one constant `SUPPLIER_ANSWER_HOURS = 12` in `public/backend/routes/inventory-clerk.js`.
- Labels: **No Answer**, **Cancelled**, popup field **Answer By**, button **Cancel Order**, feature **Cancel Purchase Orders** (key `po-cancel`, module Inventory, available and default Manager + Inventory Clerk).
- The manager's Decline at approval still shows **Declined** (`status = 'Cancelled'` with `closed_as IS NULL`).
- Not changed: shortage-notice link, no "Send again", no cancellation email, no cancel once the supplier accepted.
- User rules: plain readable code with short comments; no helper notes/hints on screens; status labels are `.badge` dot + text; buttons go in the popup footer, never in table rows.
- Never test against the live `hardware_db`. Use a `hardware_db_test` copy on port 3100 (see the test setup below), and drop it afterwards.
- Do not commit. The user sees the screens first; the final commit happens after their OK, without any Co-Authored-By line.

## Test setup (used by every task)

No test suite is kept in the repo. Tests are one scratch script, `<scratchpad>/po-limit.test.js` (plain Node, built-in `fetch` and `assert`), run against a server on the test copy:

1. Build the copy: for files `1-database.sql`, `2-stored-procedures.sql`, `6-SAMPLE-purchase-orders.sql`, pipe `sed -e 's/hardware_db\b/hardware_db_test/g'` into `"C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe" -uroot` (password from `.env` `DB_PASSWORD` via `MYSQL_PWD`). Check first that the renamed text contains no `hardware_db` without `_test`. File 6 needs the server's start-up upgrades, so start the server once (step 2) before loading it.
2. Server: `DB_NAME=hardware_db_test HARDWARE_PORT=3100 HARDWARE_MAIL_OFF=1 PAYMENT_PROVIDER=sim HARDWARE_BACKUP_DIR=<scratchpad>/bk node public/backend/server.js` in the background.
3. In the test copy only: `UPDATE users SET must_change_password = 0`, and set known passwords by running `node -e` with `public/backend/services/passwords.js` `hashPassword()`.
4. The script signs in with `POST /api/login` `{ email, password }` and keeps the `sid` cookie. It moves time by editing `supplier_sent_at` directly in MySQL (`mysql2/promise`, database `hardware_db_test`).
5. Afterwards: stop the server, `DROP DATABASE hardware_db_test`, and confirm live `hardware_db` routines' `MAX(LAST_ALTERED)` did not change.

## Review Focus

- **A supplier answers at the last second while the order closes.** Exactly one wins: the answer UPDATE has the 12-hour guard in its WHERE, and the close UPDATE requires `supplier_response IS NULL`. Test: set `supplier_sent_at` to 12 h 1 s ago without listing orders first, then answer → 409, order is No Answer.
- **Email It Again must not move the deadline.** Re-emailing used to set `supplier_sent_at = NOW()`, which would quietly hand out another 12 hours. It becomes `COALESCE(supplier_sent_at, NOW())`. Test: mark sent, set `sent_at` to 2 h ago, call mark-sent again → `sent_at` unchanged.
- **An approved order not yet sent (To Send, `supplier_sent_at IS NULL`) never expires.** Test: an order with null `sent_at` stays Pending after the list loads.
- **A closed order can't be received, emailed or cancelled again.** The existing `status` checks cover receive and send. Test: cancel a No Answer order → 409.
- **The manager's Decline still reads Declined, not Cancelled.** Test: a `status='Cancelled'`, `closed_as=NULL` order → frontend `poStage` returns `'Declined'` (checked in Task 3's browser check).

---

### Task 1: 12-hour expiry on the server

**Files:**
- Modify: `public/backend/database/migrations.js` (new `migratePurchaseOrderClosing()`, called at the end of the list in `migrateDatabase` after `migrateLineDescription()`)
- Modify: `public/backend/routes/inventory-clerk.js` (constant, `closeUnansweredOrders()`, GET `/api/purchase-orders`, `supplierView()`, GET `/api/supplier-order/:code`, POST `/api/supplier-order/:code/respond`, `emailOrderToSupplier()` line ~1426)
- Test: `<scratchpad>/po-limit.test.js`

**Interfaces:**
- Produces: columns `purchase_orders.closed_as ENUM('No Answer','Cancelled') NULL`, `closed_note VARCHAR(255) NULL`, `closed_at TIMESTAMP NULL`, `closed_by_staff_id INT NULL` (FK `staff(staff_id)` ON DELETE SET NULL ON UPDATE CASCADE). Added only if missing, in the style of `migrateSupplierResponse()`.
- Produces: `async function closeUnansweredOrders(): Promise<number>` in inventory-clerk.js. It sets `status='Cancelled', closed_as='No Answer', closed_at=NOW()` where `status='Pending' AND supplier_response IS NULL AND supplier_sent_at IS NOT NULL AND supplier_sent_at <= NOW() - INTERVAL SUPPLIER_ANSWER_HOURS HOUR`, and returns the affected rows. When > 0 it calls `publishChange("inventory", "orders closed without an answer", null)` if `publishChange` exists, and writes one audit row per closed order (`PURCHASE_ORDER_NO_ANSWER`, `"<PO-number> closed: <supplier> did not answer within 12 hours"`), using the system form of `writeAuditLog` the archive sweep uses (staff null).
- Produces, in the GET `/api/purchase-orders` rows: `closed_as`, `closed_note`, `closed_at`, `closed_by` (staff full_name, LEFT JOIN), `answer_by` = `IF(po.supplier_sent_at IS NULL, NULL, DATE_ADD(po.supplier_sent_at, INTERVAL 12 HOUR))`. Add each to GROUP BY.
- Produces, in `supplierView(document).order`: `closed_as`, `closed_at`, `answer_by` (same rule). `readOrderDocument` must select them.

- [ ] **Step 1: Write the failing tests** in `po-limit.test.js`:
  - `expiry_closes_after_12h`: pick the sample "Sent to Supplier" order (Cebu Tool Co., file 6). Set `supplier_sent_at = NOW() - INTERVAL 13 HOUR`. GET `/api/purchase-orders` as clerk → that row has `status === 'Cancelled'`, `closed_as === 'No Answer'`, `closed_at` not null.
  - `late_answer_refused`: on another sent order, set `sent_at` to `NOW() - INTERVAL 12 HOUR - INTERVAL 1 SECOND`. Without listing first, POST `/api/supplier-order/<code>/respond` `{ accept: true, shipDate: <tomorrow> }` → status 409, `error` contains `"expired"`. Order row → `closed_as === 'No Answer'`, `supplier_response` null.
  - `answer_in_time_accepted`: `sent_at` = `NOW() - INTERVAL 11 HOUR`, respond accept → 200, `supplier_response === 'Accepted'`.
  - `to_send_never_expires`: an approved order with `supplier_sent_at` NULL, after GET list → still `status === 'Pending'`, `closed_as` null.
  - `answer_by_is_sent_plus_12h`: for a sent open order, `answer_by` minus `supplier_sent_at` equals 12 h exactly.
  - `resend_keeps_deadline`: a code check rather than a request, because mail is off on the test server and `/send` stops before the UPDATE. Assert that the source of `inventory-clerk.js` no longer contains `SET supplier_sent_at = NOW() WHERE po_id` and does contain `supplier_sent_at = COALESCE(supplier_sent_at, NOW())` in `emailOrderToSupplier`. Also POST `/mark-sent` on an order sent 2 h ago → `sent_at` is unchanged.
  - `supplier_page_shows_expiry`: GET `/api/supplier-order/<code>` for the expired order → `order.can_respond === false`, `order.closed_as === 'No Answer'`, `order.closed_at` set.

- [ ] **Step 2: Run** `node <scratchpad>/po-limit.test.js`. Expected: FAIL (the columns are unknown, the row is still Pending).

- [ ] **Step 3: Implement.**
  - Add the migration.
  - Add the constant and `closeUnansweredOrders()`. Call it first thing in GET `/api/purchase-orders`, GET `/api/supplier-order/:code`, and POST `/api/supplier-order/:code/respond`.
  - In the respond UPDATE, add to its WHERE: `AND (supplier_sent_at IS NULL OR supplier_sent_at > NOW() - INTERVAL 12 HOUR)`.
  - When that UPDATE changes 0 rows and the re-read order has `closed_as === 'No Answer'`, the 409 error is `"<number> expired on <closed_at as 'Nov 21, 2026 2:30 PM'> without an answer. Contact the shop."`. When `closed_as === 'Cancelled'`: `"<number> was cancelled by the shop. Contact the shop."`. Use the date formatter the file already uses for supplier-facing times.
  - Change `emailOrderToSupplier`'s `SET supplier_sent_at = NOW()` to `COALESCE(supplier_sent_at, NOW())`.

- [ ] **Step 4: Run** the tests. Expected: all Task 1 tests PASS.

### Task 2: Shop cancel on the server

**Files:**
- Modify: `public/backend/routes/inventory-clerk.js` (new route after `/mark-sent`)
- Modify: `public/backend/features.js` (new entry after `po-undo-receiving`)
- Modify: `public/backend/access-control.js` (ACCESS_RULES, next to the undo-receiving rule)
- Test: `<scratchpad>/po-limit.test.js`

**Interfaces:**
- Consumes: the Task 1 columns.
- Produces: `POST /api/purchase-orders/:poId/cancel` with body `{ reason: string }`. Responses:
  - 400 `"Write why the order is cancelled."` when the trimmed reason is under 5 characters (keep the first 255).
  - 404 when the order doesn't exist.
  - 409 with a reason when it can't be cancelled: For Approval → `"<number> is not approved yet. The manager can decline it instead."`; accepted → `"<supplier> already accepted <number>. Phone them to stop the delivery."`; declined by the supplier, or already closed → `"<number> is already closed."`.
  - 200 `{ message: "<number> is cancelled. <supplier>'s link no longer works." }`.
  - It does `closeUnansweredOrders()` first, then one UPDATE: `SET status='Cancelled', closed_as='Cancelled', closed_note=?, closed_at=NOW(), closed_by_staff_id=? WHERE po_id=? AND status='Pending' AND supplier_response IS NULL`. On 0 rows it re-reads the order to pick the 409 text. Then it writes audit `PURCHASE_ORDER_CANCELLED` and calls `publishChange("inventory", "cancelled <number>", request.headers["x-client-id"] || null)`.
- Produces: feature `{ key: "po-cancel", name: "Cancel Purchase Orders", module: "Inventory", description: "Cancel an order the supplier has not answered yet. The supplier's link stops working at once.", available: [MANAGER, CLERK], defaults: [MANAGER, CLERK], routes: [GET list, GET items, GET document, POST cancel] }`. Use the same route regexes as `po-undo-receiving`, plus `/^\/api\/purchase-orders\/\d+\/cancel$/`.
- Produces: access rule `["POST", /^\/api\/purchase-orders\/\d+\/cancel$/, [MANAGER, CLERK]]`.

- [ ] **Step 1: Write the failing tests:**
  - `cancel_needs_reason`: as clerk, POST cancel `{ reason: "no" }` → 400.
  - `cancel_sent_order`: on an open sent order, reason "Found it cheaper elsewhere" → 200. Row: `status 'Cancelled'`, `closed_as 'Cancelled'`, `closed_note` equals the reason, `closed_by_staff_id` is the clerk's staff id. Supplier respond → 409, error contains `"cancelled by the shop"`.
  - `cancel_to_send_order`: an approved order not yet sent → 200.
  - `cancel_accepted_refused`: on an Out for Delivery order → 409, error contains `"already accepted"`.
  - `cancel_closed_refused`: on the No Answer order from Task 1 → 409 `"already closed"`.
  - `cancel_for_approval_refused`: → 409.
  - `cancel_by_manager_ok`: the manager cancels an open order → 200.
  - `cancel_by_cashier_forbidden`: → 403.
- [ ] **Step 2: Run.** Expected: FAIL (404, no such route).
- [ ] **Step 3: Implement** the route, the feature entry and the access rule.
- [ ] **Step 4: Run.** Expected: all Task 1 and Task 2 tests PASS.

### Task 3: Staff screen (Purchase Orders / Order History popup)

**Files:**
- Modify: `public/frontend/connections/shared-connection.js` (next to `apiUndoReceiving`)
- Modify: `public/frontend/scripts/shared/purchase-orders.js` (`PO_STATES`, `poStage`, `PO_STAGE_TONES`, `openPurchaseOrderDetail` summary and footer, new `poCanCancel` + `cancelPurchaseOrder` next to `poCanUndoReceiving`)

**Interfaces:**
- Consumes: the Task 1 list fields, the Task 2 route.
- Produces: `function apiCancelPurchaseOrder(poId, reason)` → `sendJson('/api/purchase-orders/' + poId + '/cancel', 'POST', { reason: reason })`.
- Produces: `poStage(po)` returns `'No Answer'` or `'Cancelled'` when `po.status === 'Cancelled' && po.closed_as`, and `'Declined'` when `closed_as` is empty. `PO_STATES` gains `{ status: 'No Answer', label: 'No Answer' }` and `{ status: 'Cancelled', label: 'Cancelled' }` after Declined, so they also show up in the status filter. Tones: `'No Answer': 'badge-neutral'`, `'Cancelled': 'badge-danger'`.
- Produces: `function poCanCancel(po)`, true when `(poSetup.canDecide || poSetup.canReceive) && holdsFeature('po-cancel') && po.status === 'Pending' && !po.supplier_response`. And `async function cancelPurchaseOrder(poId)`, modelled on `undoReceiving`: `askInput` with title `'Cancel this order?'`, message `poNumber + ' is cancelled and ' + supplier + '\'s link stops working.'`, label `'Reason'`, confirmLabel `'Cancel Order'`, tone danger, and the 5-character check `'Write why the order is cancelled.'`. Then `notifySuccess(result.message, 'Order cancelled')`, refresh, `poAfterChange()`.

- [ ] **Step 1: Popup summary.**
  - When `poStage(po) === 'Sent to Supplier'`, add `detailField('Answer By', escapeHtml(poWhen(po.answer_by)))`.
  - When `closed_as === 'No Answer'`, add `detailField('No Answer', poWhen(po.closed_at))`.
  - When `closed_as === 'Cancelled'`, add `detailField('Cancelled', when + ' <span class="muted">by ' + closed_by + '</span>')` and `detailField('Reason', escapeHtml(po.closed_note))`.
  - The existing `'Declined by Manager'` label and `"Manager's Remarks"` field must show only when `po.status === 'Cancelled' && !po.closed_as`. When `closed_as` is set, `confirmed_at` gets the label `'Approved'`.
- [ ] **Step 2: Footer.** When `poCanCancel(po) && !readOnly`, add `<button class="btn btn-danger" onclick="cancelPurchaseOrder(id)">Cancel Order</button>`.
- [ ] **Step 3: Browser check** on the test server (port 3100), signed in as clerk:
  - A sent order's popup shows Answer By, 12 h after it was sent.
  - Cancel Order without a reason shows the error. With a reason, the order shows Cancelled in the list and the popup.
  - The expired order shows No Answer.
  - A manager-declined order still shows Declined.
  - Signed in as cashier, there's no Cancel Order button anywhere.
  - Receive Deliveries and the "Sent to Supplier" filter no longer list the closed orders.
  - The console has no errors.

### Task 4: Supplier page

**Files:**
- Modify: `public/frontend/scripts/supplier-order.js` (`renderReceipt`, `trackHtml`)

**Interfaces:**
- Consumes: `view.order.closed_as`, `closed_at`, `answer_by` from Task 1.

- [ ] **Step 1: Closed messages.** In `renderReceipt`, inside the `!order.supplier_response` branch:
  - When `order.closed_as === 'No Answer'`: title `'Order expired'`, sub `order.number + ' expired on ' + stampText(order.closed_at) + ' without an answer. Contact the shop.'`.
  - When `'Cancelled'`: title `'Order cancelled'`, sub `'The shop cancelled ' + order.number + ' on ' + stampText(order.closed_at) + '. Contact the shop.'`.
  - Otherwise keep the current text.
- [ ] **Step 2: Deadline while open.** In `trackHtml`, the "Your answer" stop's sub becomes `'By ' + stampText(order.answer_by)` when `!order.supplier_response && order.answer_by`. Otherwise it stays as today.
- [ ] **Step 3: Browser check** on `http://localhost:3100/supplier-order.html?...` (use the link format `supplierAnswerLink` builds) for an open, an expired and a cancelled order. An answer attempt on the expired one shows the server's 409 text. No console errors.

### Task 5: Show the user, then commit

- [ ] **Step 1:** Run the full `po-limit.test.js` once more. All tests PASS.
- [ ] **Step 2:** Take screenshots for the user: the staff popup (open with Answer By, No Answer, Cancelled with reason) and the supplier page (open with deadline, expired, cancelled). Send them.
- [ ] **Step 3:** Clean up the test copy as described in Test setup step 5.
- [ ] **Step 4:** After the user's OK, commit the spec, the plan and the code in one commit: `"Purchase orders: 12-hour answer limit and shop cancel"`, with no Co-Authored-By line. Don't push.
