# Late Payment Penalty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The manager sets a late-payment penalty rate on the Credit Maintenance page, the rate is written on the customer's terms, and overdue credit sales are charged it automatically.

**Architecture:** Reuse what is already in the database (`store_settings.penalty_rate`, `sp_set_penalty_policy`, `sp_apply_late_penalties`, the `sales.penalty_*` columns) and the procedure wrappers already in `public/backend/database/procedures/manager-procedures.js` (`setPenaltyPolicy`, `applyLatePenalties`). Add back two routes, the sweep, and one card on the page. The penalty sentence is built in one frontend function and added to the Credit Policy lines wherever the card back or terms page is drawn.

**Tech Stack:** Node/Express, MySQL stored procedures, plain HTML/CSS/JS (no new tools).

**Spec:** `docs/superpowers/specs/2026-11-26-late-payment-penalty-design.md`

## Global Constraints

- Plain, simple JS and CSS like the rest of the project; no new libraries.
- Rate is 1 to 3 percent a month, two decimals (the database CHECK and `sp_set_penalty_policy` enforce this).
- Percent inputs are left-aligned (no `amount-field` class).
- Screens get labels, fields, values and real errors only — no helper sentences or hints.
- Never use the word "booking". Never commit or push; the user commits after seeing the screen.
- Test only against `hardware_db_test` on port 3100 (launch config `test-copy`). Never run the sweep against `hardware_db`.
- Old git history for reference: commit `02a30ec` removed the previous version (`git show 02a30ec -- public/backend/routes/manager.js`).

## Review Focus

1. Rate typed as blank, 0, 0.5, 4, or text → not saved, real error "The late-payment rate is 1 to 3 percent a month."; 2.5 saves.
2. Sweep run twice the same day → no sale charged twice (the procedure compares `penalty_months`).
3. A credit sale already paid in full, or not yet due → never charged.
4. Manager without the `late-payment-penalty` switch → card hidden, routes refused (403).
5. Long Credit Policy plus the penalty line → card preview's existing "too small to read" warning still works.

---

### Task 1: Backend — routes, access, sweep, terms data

**Files:**
- Modify: `public/backend/routes/manager.js` (new routes near `/api/loyalty/policy` ~line 1117; `creditPrintData` ~1239; `/api/policies` ~1313; final `return {}` ~1967)
- Modify: `public/backend/features.js` (new entry after `credit-maintenance` ~line 74; fix that entry's description)
- Modify: `public/backend/access-control.js` (~line 190)
- Modify: `public/backend/routes/shared.js` (`/api/cron/daily` steps ~line 643)
- Modify: `public/backend/server.js` (`app.listen` callback ~line 356)
- Test: `<scratchpad>/penalty-api-check.js` (throwaway Node script, not committed)

**Interfaces:**
- Consumes: `managerProcedures.setPenaltyPolicy([rate, staffId])` → `{status_code, message}`; `managerProcedures.applyLatePenalties()` → `{applied, total, err_no, err_text}`.
- Produces:
  - `GET /api/credit/penalty-policy` → `{ penalty_rate: "3.00" }`
  - `PUT /api/credit/penalty-policy` body `{ penaltyRate: number }` → `{ message, penalty_rate: "2.50" }`, or 400 `{ error }`
  - `/api/policies` response gains `penaltyRate: number`
  - `creditPrintData(...)` result `terms` gains `penalty_rate: number`
  - `registerManagerRoutes` returns `{ startPenaltySweep(), runPenaltySweep() }`
  - feature key `late-payment-penalty` (name "Late Payment Penalty", module "Policy Maintenance", MANAGER only, routes the two above)

- [ ] **Step 1: Write the check script** (`penalty-api-check.js`, uses `fetch`, BASE `http://localhost:3100`, signs in as `manager@hardware.com` / seed password from README, keeps the cookie). Assertions:
  - GET penalty-policy → 200, `penalty_rate === "3.00"`
  - PUT `{penaltyRate: 4}`, `0.5`, `""`, `"abc"` → each 400 with `error` containing "1 to 3 percent"
  - PUT `{penaltyRate: 2.5}` → 200; GET → `"2.50"`; PUT 3 back → 200
  - GET `/api/policies` → `typeof penaltyRate === "number"`
  - GET `/api/credit/card/1` → `typeof terms.penalty_rate === "number"`
  - Signed in as cashier: PUT penalty-policy → 403
- [ ] **Step 2: Run it before the change** — `node <scratchpad>/penalty-api-check.js` → FAIL (404 on penalty-policy).
- [ ] **Step 3: Routes.** Add the GET/PUT in `manager.js` with `requireRole(MANAGER)`, validating `Number.isFinite(rate) && rate >= 1 && rate <= 3` before calling `setPenaltyPolicy`; on save `writeAuditLog(request, "UPDATE_PENALTY_POLICY", ..., { changes: fieldChanges(old, new) })` and `publishChange("credit", "penalty-policy", null)`. Add `penaltyRate: Number(row.penalty_rate)` to `/api/policies` and `penalty_rate` to `creditPrintData().terms` (read from `store_settings`, fallback 3).
- [ ] **Step 4: Access + feature.** Two `ACCESS_RULES` lines `[MANAGER]`; the `features.js` entry; change `credit-maintenance` description to drop "no late-payment penalty is charged".
- [ ] **Step 5: Sweep.** In `manager.js` add `runPenaltySweep()` (calls `applyLatePenalties`, logs, on `applied > 0` publishes `credit`, `sales`, `notifications` changes; on `applied < 0` logs the database error) and `startPenaltySweep()` (runs once, then every 60 minutes with `setInterval`); return both. In `server.js` call `managerModule.startPenaltySweep()` inside the `app.listen` callback only (not on Vercel). In `shared.js` add `penalties: function () { return managerModule.runPenaltySweep(); }` to the daily steps.
- [ ] **Step 6: Run the check** — restart `test-copy`, run the script → all PASS. Server log shows "Late-payment sweep: N overdue sales charged ..." once on start; restart again → no new charge (check `SELECT SUM(penalty_amount) FROM hardware_db_test.sales` is the same before and after).

### Task 2: Frontend — card, preview line, printed terms

**Files:**
- Modify: `public/frontend/manager.html` (`#panel-credit-maintenance` ~line 780: new card before the Credit Policy card)
- Modify: `public/frontend/connections/manager-connection.js` (next to `apiGetLoyaltyPolicy`)
- Modify: `public/frontend/scripts/manager.js` (`showCreditMaintenance` ~143, `previewCardBack` ~1954, `policyChangesUnsaved`)
- Modify: `public/frontend/scripts/shared/credit-terms.js` (`creditTermsPage`, `customerCardSheet`)

**Interfaces:**
- Consumes: Task 1 routes and `penaltyRate` / `terms.penalty_rate`.
- Produces: `latePenaltyLine(rate: number) -> string` in `credit-terms.js`, exact copy:
  `'A late payment is charged ' + penaltyRateWord(rate) + ' a month of the unpaid balance, for each month past the due date.'`
  (`penaltyRateWord` already exists in `shared/format.js`.) `apiGetPenaltyPolicy()`, `apiSavePenaltyPolicy(rate)`.

- [ ] **Step 1: Card markup.** `<div class="card" data-feature="late-payment-penalty">` with heading "Late Payment Penalty", form `#penalty-form` (`onsubmit="savePenaltyPolicy(event)"`), one `form-group`: label "Penalty rate, percent a month", `<input type="number" name="rate" class="form-control" min="1" max="3" step="0.01" required oninput="previewCardBack()">`, footer with `<button type="submit" class="btn btn-success">Save</button>`. Same structure as `#loyalty-card`.
- [ ] **Step 2: Scripts.** `loadPenaltyPolicy()` / `savePenaltyPolicy(event)` in `manager.js` following `saveLoyaltyPolicy` (client check 1–3 with the same error text as the server, `notifySuccess(result.message, 'Penalty saved')`). `showCreditMaintenance` loads it when `holdsFeature('late-payment-penalty')`. In `previewCardBack`, append `latePenaltyLine(rate)` to `policies.credit`, where rate is the typed value when it is 1–3, else `policyData.penaltyRate`. Add the penalty rate to `policyChangesUnsaved` (returns `'the late-payment penalty'` when typed ≠ saved).
- [ ] **Step 3: Printed card and terms.** In `customerCardSheet` and `creditTermsPage` append `latePenaltyLine(data.terms.penalty_rate)` to the credit lines; in `creditTermsPage` add `creditPrintRow('Late payment', ...)` after the Interest row with the same sentence.
- [ ] **Step 4: Verify in the browser** (`test-copy`, manager login): card shows 3.00; typing 2.5 updates the preview line to "2.5% a month"; Save → success toast, reload shows 2.50; typing 4 → Save shows the error, nothing saved; leaving with an unsaved rate warns. Cashier → print customer card / credit terms for a credit customer shows the line. No console errors. Screenshot for the user.
