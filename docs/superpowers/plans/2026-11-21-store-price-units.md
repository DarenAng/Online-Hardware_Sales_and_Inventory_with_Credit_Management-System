# Store Screens: Liter / Can / Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Staff can order, receive and see prices in any unit a material has (base unit, its selling units, its delivery pack), the same way the supplier page already does.

**Approved design (user, 2026-11-21):**
1. **Raising the order** (New Purchase Order form). Each line's unit select (`.po-in`) lists every unit of the picked material, e.g. "liter", "can (4 liter)", "box (16 liter)".
   - The units are: the base unit (size 1); each `selling_units` row (`unit_name`, `units_per`) that `poMaterials` already carries; and the product's delivery pack (`pack_name`/`pack_size`). Duplicates (same name, case-insensitive, and same size) are listed once.
   - The default stays as today: the delivery pack if the material has one, otherwise the base unit.
   - When a unit bigger than 1 is chosen, the line is saved with `packName` = unit name, `packSize` = its size, `packCount` = the typed quantity, and `quantity` = typed × size in base units. This is the request shape the form already sends for the delivery pack, so the server and stored procedure need no change. The base unit saves with no pack, as today.
   - The quantity label reads "Quantity (can)" etc., as it does today for the pack.
   - The select shows whenever the material has more than one unit.
2. **Receiving the delivery** (Receive Delivery form). Each line's "Arrived" input gets a unit select with the same list for that material, defaulting to the unit the line was ordered in.
   - The typed number × chosen size = base units arrived. That base number is what is sent to the server, exactly as today.
   - "Expected" and "Short" keep showing in the ordered unit, as today.
   - One unit per line: "1 box + 3 can" is entered as "7 can" or "28 liter".
   - The "Add something that arrived" extra rows are not changed.
3. **Seeing the price** (staff PO popup, Ordered Items table and the Removed by supplier table). The Unit Cost cell shows the price in the line's unit, as today, then a muted line listing the other units, e.g. "₱2,400.00 per box" with "₱600.00 per can · ₱150.00 per liter" below.
   - Every unit of the material is listed. A line with only the base unit shows just one price.
   - The struck-through original price (supplier's price) keeps working.

**Server change (minimal):** the staff screens need each item's unit list. `GET /api/purchase-orders/:poId/items` and `GET /api/purchase-orders/:poId/removed-items` items gain `units: [{ name, size }]`.
- Build it with the same logic `readOrderDocument` already uses for the supplier view (base unit, `product_units` by `units_per`, the product pack, the line pack; case-insensitive name + size de-duplication; ONE batched `product_units` query per request, never one per line).
- Factor that logic into a small shared function in inventory-clerk.js, so the supplier view and the two routes use the same code.

**Rules:**
- Plain readable code with short comments (student capstone). No helper sentences on screens. Numbers right-aligned in tables, no buttons in table rows.
- Never touch the live `hardware_db`; test on `hardware_db_test` only.
- Do not commit.

## Review Focus
- **A material with only the base unit:** every screen behaves exactly as today.
- **Ordering in a selling unit (can):** the saved line has `pack_name` 'can', `pack_size` 4, `pack_count` = typed, `quantity` = typed×4. Receive, the supplier page and the shortage notice show "6 can (24 liter)".
- **Receiving in a different unit than ordered** (ordered 2 box, arrived counted as 7 can): 28 liters go to stock, and Short shows 4 liter, or 1 can when the ordered unit is box. This uses the existing short logic on base units.
- **A fractional result** (e.g. 3 liter typed against a 4-liter can line) is fine. Base units sent are whole numbers when the unit size is whole. Reject a count whose base amount isn't a whole number when the material's base unit is counted in whole numbers, using the receive form's existing whole-number rule if one exists. Don't invent a new rule.
- **The per-unit price list** rounds each figure to centavos.

- [ ] Server:
  - add `staff_items_list_units` to `po-limit.test.js`: GET items for an order whose material has a selling unit and a pack returns `units` with each listed once
  - add `create_order_in_selling_unit`: POST /api/purchase-orders with `packName` 'can', `packSize` 4, `packCount` 6, `quantity` 24 saves those values
  - RED, implement, GREEN (all existing tests pass)
- [ ] Order form, receive form, popup:
  - implement, then run `node --check` on the changed files
  - script a check of the conversion helpers
  - the controller does the browser check
