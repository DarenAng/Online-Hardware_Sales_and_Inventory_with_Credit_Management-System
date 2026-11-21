# Supplier Price Unit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On the supplier's quote page, the supplier chooses which unit they type a line's price in (the base unit, a selling unit such as "can (4 liters)", or the material's delivery pack such as "box (16 liters)"). The system converts the price to the base unit as it does today.

**Approved design (user, 2026-11-21):**
- The price editor's label becomes "Your price per [unit ▾]". It is a plain `<select>` listing every unit the material has:
  - the base unit (size 1, e.g. "liter")
  - each row in `product_units` for the product, as "<unit_name> (<units_per> <base unit>s)", e.g. "can (4 liters)"
  - the product's delivery pack, if `products.pack_name`/`pack_size` are set and not already listed, e.g. "box (16 liters)"
  - the order line's own pack (`pack_name`/`pack_size` on the PO line), if not already listed
  - duplicates (same name and size) are listed once
- Default unit: the line's ordered pack when the line was ordered in a pack, otherwise the base unit. This matches today's behaviour.
- Typed price ÷ chosen unit size = base-unit cost, rounded to 4 decimals (the same rounding as today's `priceFor`). Line total = base cost × the line's base quantity (unchanged).
- After Save, the line shows the price in the chosen unit, e.g. "₱2,400.00 per box". The crossed-out old price shows in that same unit too.
- The request sent to the server is unchanged: `prices: [{ id, unitCost }]`, with `unitCost` per base unit. The server's checks, the stored data and every staff screen stay unchanged.
- No change to quantities, the PDF, the staff popup or the receive flow.

**Rules:** plain readable code with short comments (student capstone). No helper sentences on screen. Never touch the live `hardware_db`; test on `hardware_db_test` only. Do not commit.

**Files:**
- `public/backend/routes/inventory-clerk.js`:
  - `readOrderDocument` loads each item's units
  - `supplierView` items gain `units: [{ name, size }]`, built in the order: base unit, `product_units` ordered by `units_per`, the product's pack, the line's pack
  - each item also gains `base_unit` (= `unit_name`)
- `public/frontend/scripts/supplier-order.js`:
  - `draft.priceUnit = {}` (id → chosen size)
  - the price editor gets the select
  - `priceFor`, the shown price text and the input value use the chosen size instead of `packSizeOf(item)`
  - changing the unit while editing keeps the typed number and re-reads it in the new unit
  - Undo/Cancel keep working
- `public/frontend/css/pages/supplier-order.css`: style the select so it matches the existing inputs and fits on phones.

## Review Focus
- **A material with no extra units:** the select shows only the base unit, and the result is exactly today's behaviour.
- **A line ordered in a pack:** it defaults to the pack, so a typed price means the same as today.
- **Removed lines (the feature already exists):** they still skip pricing.
- **An unpriced line (unit_cost 0) priced via a larger unit:** it passes the server's "price above zero" check. A tiny per-base cost can't round to 0 unless the size is huge; reject when the rounded base cost is 0 with the existing price error.
- **Discount and totals:** they use the converted base cost.

- [ ] Server:
  - extend `po-limit.test.js` with `supplier_view_lists_units`: for a product with a `product_units` row and a pack, the GET supplier view item has `units` including the base unit (size 1), the selling unit and the pack, each once
  - also add `price_per_pack_converts`: accept with `unitCost` = 2400/16 for a 16-liter box gives stored `unit_cost` 150.0000
  - RED, implement, GREEN (all existing tests pass)
- [ ] Page: implement, `node --check`, and a request-shape check with a node script that calls the page's conversion the way `send()` does. The controller does the browser check.
