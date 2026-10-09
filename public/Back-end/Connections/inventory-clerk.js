// ============================================================
// inventory-clerk.js -- Inventory module (inventory clerk)
// Loaded by: server.js only (from the connections folder). Never sent to a browser.
//
// What is in this file:
//   - the clerk's dashboard numbers and the material (product) list
//   - selling units (e.g. nails kept by the kilo but also sold by the sack)
//   - new materials, stock adjustments and reorder points
//   - purchase orders: raised and received here, confirmed by the manager
//   - returns, damage reports and refunds
//   - notifications, which every dashboard reads
//
// server.js passes in the database and its helpers ("deps"). The access
// rules in server.js have already checked the user's role.
// ============================================================
const crypto = require("crypto");
const mailer = require("../mailer");
const isMailConfigured = mailer.isMailConfigured;
const sendMail = mailer.sendMail;
const purchaseOrderMessage = mailer.purchaseOrderMessage;
const supplierOrderLink = mailer.supplierOrderLink;
const qrPng = mailer.qrPng;
const purchaseOrderPdf = require("../purchase-order-pdf").purchaseOrderPdf;

// Gives back the first value that is not null/undefined.
// Used because the browser may send "unitCost" or "unit_cost".
function firstGiven(a, b) {
  if (a !== null && a !== undefined) {
    return a;
  }
  return b;
}

// Trims text and cuts it to "max" characters. Empty text becomes null.
function shortText(value, max) {
  const text = String(value || "").trim().slice(0, max);
  if (text === "") {
    return null;
  }
  return text;
}

// A name as typed, without case or extra spaces: " Liter " and "liter" are one.
function looseName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// The same with a plural ending taken off: "liters", "boxes", "batteries" and
// "pieces" read as liter, box, battery and piece.
function singularName(value) {
  const name = looseName(value);
  if (/[^aeiou]ies$/.test(name)) return name.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(name)) return name.slice(0, -2);
  if (/[^s]s$/.test(name)) return name.slice(0, -1);
  return name;
}

function registerInventoryRoutes(app, deps) {
  const {
    db, callProcedure, getActorId, writeAuditLog, fieldChanges, DEFAULT_STORE_SETTINGS, CASHIER,
    phoneComplaint, cleanPhone, publishChange
  } = deps;

  // ==========================================
  // INVENTORY MODULE
  // ==========================================

  // headline numbers for the clerk dashboard
  app.get("/api/inventory/summary", async (request, response) => {
    try {
      const [stockRows] = await db.query(
        `SELECT COUNT(*) AS product_count,
              COALESCE(SUM(CASE WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock,
              COALESCE(SUM(CASE WHEN COALESCE(i.quantity_in_stock, 0) > 0
                                 AND COALESCE(i.quantity_in_stock, 0) <= p.reorder_point THEN 1 ELSE 0 END), 0) AS low_stock,
              COALESCE(SUM(COALESCE(i.quantity_in_stock, 0) * p.price), 0) AS stock_value
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.product_id
       WHERE p.is_archived = FALSE`
      );
      const stock = stockRows[0];
      const [poRows] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending_po,
              COUNT(*) AS total_po
       FROM purchase_orders`
      );
      const po = poRows[0];
      const [repRows] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END), 0) AS open_reports,
              COALESCE(SUM(CASE WHEN report_type = 'Damaged' THEN quantity ELSE 0 END), 0) AS damaged_units,
              COALESCE(SUM(refund_amount), 0) AS refunded_total
       FROM returned_items`
      );
      const rep = repRows[0];
      const [archRows] = await db.query(
        "SELECT COUNT(*) AS archived FROM products WHERE is_archived = TRUE"
      );

      const arch = archRows[0];

      response.json({
        productCount: stock.product_count,
        lowStock: stock.low_stock,
        outOfStock: stock.out_of_stock,
        stockValue: stock.stock_value,
        pendingPo: po.pending_po,
        totalPo: po.total_po,
        openReports: rep.open_reports,
        damagedUnits: rep.damaged_units,
        refundedTotal: rep.refunded_total,
        archived: arch.archived
      });
    } catch (error) {
      console.error("Inventory summary failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inventory/products", async (request, response) => {
    const archived = request.query.archived === "true";

    try {
      const [rows] = await db.query(
        `SELECT p.product_id, p.product_name, p.price, p.reorder_point, p.status,
              p.pack_name, p.pack_size,
              p.is_archived, p.archived_at, p.created_at,
              COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock,
              i.last_updated,
              c.category_name, b.brand_name, u.unit_name,
              sup.supplier_id, sup.supplier_name, sup.contact_person, sup.contact_number,
              NULLIF(TRIM(sup.email), '') AS supplier_email,
              NULLIF(TRIM(sup.address), '') AS supplier_address,
              (COALESCE(i.quantity_in_stock, 0) * p.price) AS stock_value,
              CASE
                WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 'Out of Stock'
                WHEN COALESCE(i.quantity_in_stock, 0) <= p.reorder_point THEN 'Low Stock'
                ELSE 'In Stock'
              END AS stock_status,
              GREATEST((p.reorder_point * 2) - COALESCE(i.quantity_in_stock, 0), 0) AS suggested_order,
              COALESCE(ar.full_name, '') AS archived_by,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                        'product_unit_id', pu.product_unit_id, 'unit_name', pu.unit_name,
                        'units_per', pu.units_per, 'price', pu.price))
               FROM product_units pu WHERE pu.product_id = p.product_id) AS selling_units
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.product_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id
       LEFT JOIN staff ar ON ar.staff_id = p.archived_by_staff_id
       WHERE p.is_archived = ?
       ORDER BY (COALESCE(i.quantity_in_stock, 0) <= p.reorder_point) DESC, p.product_name`,
        [archived]
      );
      for (const row of rows) row.selling_units = sellingUnitsOf(row.selling_units);
      response.json(rows);
    } catch (error) {
      console.error("Inventory products failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // SELLING UNITS -- the sizes a material also sells in. Stock stays in the
  // product's own unit; a row here says one "sack" is 25 of it, at its own
  // price. The clerk keeps the list; the till offers it beside the unit.
  // ==========================================
  // the JSON_ARRAYAGG column above arrives parsed or as text depending on the driver
  function sellingUnitsOf(value) {
    let list = value;
    if (typeof list === "string") {
      try { list = JSON.parse(list); } catch (error) { list = null; }
    }
    if (!Array.isArray(list)) return [];

    const units = [];
    for (const unit of list) {
      let price = null;
      if (unit.price !== null && unit.price !== undefined) {
        price = Number(unit.price);
      }

      const cleaned = {
        product_unit_id: Number(unit.product_unit_id),
        unit_name: String(unit.unit_name || ""),
        units_per: Number(unit.units_per),
        price: price
      };

      // skip broken rows (no name, or a size of zero)
      if (cleaned.unit_name !== "" && cleaned.units_per > 0) {
        units.push(cleaned);
      }
    }

    // smallest size first
    units.sort(function (a, b) {
      return a.units_per - b.units_per;
    });
    return units;
  }

  async function listSellingUnits(productId) {
    const [rows] = await db.query(
      `SELECT product_unit_id, product_id, unit_name, units_per, price, created_at
     FROM product_units WHERE product_id = ? ORDER BY units_per, unit_name`,
      [productId]);
    return rows;
  }

  app.get("/api/inventory/products/:productId/units", async (request, response) => {
    try {
      response.json(await listSellingUnits(request.params.productId));
    } catch (error) {
      console.error("Listing selling units failed:", error.message);
      response.status(500).json({ error: "Unable to read the selling units" });
    }
  });

  // Adding a size: the name is trimmed and kept as typed, units_per says how
  // many of the product's own unit it holds, and a blank price means the
  // product's price times units_per. The same name again replaces the row.
  app.post("/api/inventory/products/:productId/units", async (request, response) => {
    const productId = Number(request.params.productId);
    const body = request.body || {};
    const unitName = String(body.unitName || "").trim().slice(0, 20);
    const unitsPer = Number(body.unitsPer);
    let price;
    if (body.price === null || body.price === undefined || String(body.price).trim() === "") {
      price = null;
    } else {
      price = Number(body.price);
    }

    if (unitName === "") return response.status(400).json({ error: "Name the size, like box or sack." });
    if (!Number.isFinite(unitsPer) || unitsPer <= 0) {
      return response.status(400).json({ error: "Say how many of the product's own unit one of these holds." });
    }
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      return response.status(400).json({ error: "The price has to be a figure, or left empty." });
    }

    try {
      const [products] = await db.query(
        `SELECT p.product_id, p.product_name, p.price, u.unit_name
       FROM products p LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE p.product_id = ?`, [productId]);
      if (products.length === 0) return response.status(404).json({ error: "That material was not found." });
      const product = products[0];

      if (product.unit_name && product.unit_name.toLowerCase() === unitName.toLowerCase()) {
        return response.status(400).json({
          error: `${product.product_name} is already kept by the ${product.unit_name}; add a bigger size, like box or sack.`
        });
      }

      await db.query(
        `INSERT INTO product_units (product_id, unit_name, units_per, price)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE units_per = VALUES(units_per), price = VALUES(price)`,
        [productId, unitName, unitsPer, price]);

      // the price of one of this size (worked out from the unit price when none was given)
      let each = price;
      if (price === null) {
        each = Math.round(Number(product.price) * unitsPer * 100) / 100;
      }
      await writeAuditLog(request, "UPDATE_SELLING_UNIT",
        `${product.product_name} sells by the ${unitName}: ${unitsPer} ${product.unit_name || ""} at ${each.toFixed(2)}`,
        { product_id: productId, unit_name: unitName, units_per: unitsPer, price: price });

      response.json({
        message: `${product.product_name} now sells by the ${unitName} (${unitsPer} ${product.unit_name || "units"}).`,
        units: await listSellingUnits(productId)
      });
    } catch (error) {
      console.error("Saving a selling unit failed:", error.message);
      response.status(500).json({ error: "Unable to save that size" });
    }
  });

  // Sales already written in a size keep their own copy of it (sale_items.sold_unit),
  // so taking a size off the list changes nothing that has been sold.
  app.delete("/api/inventory/products/:productId/units/:unitId", async (request, response) => {
    const productId = Number(request.params.productId);
    const unitId = Number(request.params.unitId);

    try {
      const [rows] = await db.query(
        `SELECT pu.unit_name, p.product_name FROM product_units pu
       JOIN products p ON p.product_id = pu.product_id
       WHERE pu.product_unit_id = ? AND pu.product_id = ?`, [unitId, productId]);
      if (rows.length === 0) return response.status(404).json({ error: "That size is not on the list." });

      await db.query("DELETE FROM product_units WHERE product_unit_id = ?", [unitId]);

      await writeAuditLog(request, "REMOVE_SELLING_UNIT",
        `${rows[0].product_name} no longer sells by the ${rows[0].unit_name}`,
        { product_id: productId, unit_name: rows[0].unit_name });

      response.json({
        message: `${rows[0].product_name} no longer sells by the ${rows[0].unit_name}.`,
        units: await listSellingUnits(productId)
      });
    } catch (error) {
      console.error("Removing a selling unit failed:", error.message);
      response.status(500).json({ error: "Unable to remove that size" });
    }
  });

  // Suppliers, categories and units are added by the manager only (Records on
  // the manager's page). A name typed here is matched to the one on file and
  // swapped for it, so "liters" or "PAINTS" files under "liter" or "Paint"
  // rather than a second copy; a name with no match is refused with what to do.
  // Gives back { error } or { category(name), unit(name) }, which return the name on file.
  async function namesOnFile(categoryNames, unitNames) {
    const categories = await matchOnFile(
      "SELECT category_name AS name FROM categories", categoryNames);
    if (categories.missing) {
      return { error: `The category "${categories.missing}" is not on file. Only the manager can add a category; ` +
                      "pick one on the list, or ask the manager to add it under Records." };
    }

    const units = await matchOnFile("SELECT unit_name AS name FROM units", unitNames);
    if (units.missing) {
      return { error: `The unit "${units.missing}" is not on file. Only the manager can add a unit; ` +
                      "pick one on the list, or ask the manager to add it under Records." };
    }

    return { category: categories.onFile, unit: units.onFile };
  }

  async function matchOnFile(sql, typedNames) {
    const typed = typedNames.map((value) => String(value || "").trim()).filter((value) => value !== "");
    const onFile = new Map();     // what was typed -> the name on file
    if (typed.length === 0) return { onFile: (value) => value };

    const [rows] = await db.query(sql);
    for (const value of typed) {
      // the same spelling first, so "Liter" never loses to a "Liters" also on file
      const same = rows.find((row) => looseName(row.name) === looseName(value)) ||
                   rows.find((row) => singularName(row.name) === singularName(value));
      if (!same) return { missing: value };
      onFile.set(looseName(value), same.name);
    }

    return {
      onFile: (value) => {
        const text = String(value || "").trim();
        if (text === "") return value;
        return onFile.get(looseName(text)) || text;
      }
    };
  }

  // Adding a material from the shop floor: its category and unit must already
  // be on file; a new brand is created alongside it. An existing name returns
  // the existing material.
  app.post("/api/materials", async (request, response) => {
    const { name, brandName, categoryName, unitName, price, supplierId } = request.body;

    if (!name || String(name).trim() === "") {
      return response.status(400).json({ error: "A material needs a name" });
    }

    try {
      const onFile = await namesOnFile([categoryName], [unitName]);
      if (onFile.error) return response.status(400).json({ error: onFile.error });

      const output = await callProcedure(
        "CALL sp_create_material(?, ?, ?, ?, ?, ?, ?, @product_id, @status_code, @message)",
        [String(name).trim().slice(0, 150),
         String(brandName || "").trim().slice(0, 100),
         String(onFile.category(categoryName) || "").slice(0, 50),
         String(onFile.unit(unitName) || "").slice(0, 20),
         Number(price) || 0,
         Number(supplierId) || null,
         getActorId(request)],
        ["product_id", "status_code", "message"]
      );

      if (output.status_code !== 201 && output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({
        message: output.message,
        productId: output.product_id,
        created: output.status_code === 201
      });
    } catch (error) {
      console.error("Create material failed:", error.message);
      response.status(500).json({ error: "Unable to add the material" });
    }
  });

  // STOCK ADJUSTMENT
  // Units: a unit typed on an adjustment is added; the same clerk can rename
  // one, and renaming onto an existing name merges.
  // How a material is delivered: a "box" of 20 of its unit. Blank clears it.
  // Orders and deliveries are then counted in that pack; stock stays in the unit.
  app.put("/api/inventory/products/:productId/pack", async (request, response) => {
    const productId = Number(request.params.productId);
    const body = request.body || {};
    const name = String(body.packName || "").trim().slice(0, 20);
    const size = Number(body.packSize);

    if (name !== "" && (!Number.isFinite(size) || size <= 0)) {
      return response.status(400).json({ error: "Say how much of the unit one pack holds, like 20." });
    }

    try {
      const [rows] = await db.query(
        `SELECT p.product_name, p.pack_name, p.pack_size, u.unit_name
         FROM products p LEFT JOIN units u ON u.unit_id = p.unit_id
         WHERE p.product_id = ?`, [productId]);
      if (rows.length === 0) return response.status(404).json({ error: "Product not found" });
      const before = rows[0];

      // with no pack name, the pack is removed (both saved as null)
      let packName = null;
      let packSize = null;
      if (name) {
        packName = name;
        packSize = Math.round(size * 1000) / 1000;   // keep 3 decimals at most
      }

      let beforeSize = null;
      if (before.pack_size !== null) {
        beforeSize = Number(before.pack_size);
      }

      await db.query(
        "UPDATE products SET pack_name = ?, pack_size = ? WHERE product_id = ?",
        [packName, packSize, productId]);

      const unit = before.unit_name || "unit";
      let message;
      if (name) {
        message = `${before.product_name} is delivered by the ${name} of ${packSize} ${unit}.`;
      } else {
        message = `${before.product_name} is delivered by the ${unit} again.`;
      }

      await writeAuditLog(request, "UPDATE_PACK", message, {
        product_id: productId,
        changes: fieldChanges(
          { pack_name: before.pack_name, pack_size: beforeSize },
          { pack_name: packName, pack_size: packSize })
      });

      response.json({ message: message, packName: packName, packSize: packSize });
    } catch (error) {
      console.error("Delivery pack failed:", error.message);
      response.status(500).json({ error: "Unable to save how this is delivered" });
    }
  });

  app.put("/api/units/:unitId", async (request, response) => {
    const { unitName } = request.body;

    if (!unitName || String(unitName).trim() === "") {
      return response.status(400).json({ error: "A unit needs a name" });
    }

    try {
      const output = await callProcedure(
        "CALL sp_rename_unit(?, ?, ?, @merged, @status_code, @message)",
        [request.params.unitId, String(unitName).trim().slice(0, 20), getActorId(request)],
        ["merged", "status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({ message: output.message, merged: output.merged === 1 });
    } catch (error) {
      console.error("Rename unit failed:", error.message);
      response.status(500).json({ error: "Unable to rename the unit" });
    }
  });

  app.get("/api/inventory/adjustments", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT a.adjustment_id, a.adjustment_type, a.quantity_before, a.quantity_change,
              a.quantity_after, a.reason, a.created_at,
              p.product_name,
              -- What the entry itself says it counted, falling back to the
              -- material's unit today only for entries filed before the log
              -- recorded one. The entry's own answer always wins: renaming a
              -- unit must not rewrite what last year's rows say they counted.
              COALESCE(NULLIF(TRIM(a.unit_name), ''), u.unit_name) AS unit_name,
              u.unit_name AS current_unit,
              COALESCE(s.full_name, 'System') AS adjusted_by
       FROM stock_adjustments a
       JOIN products p ON p.product_id = a.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN staff s ON s.staff_id = a.adjusted_by_staff_id
       ORDER BY a.adjustment_id DESC
       LIMIT 200`
      );
      response.json(rows);
    } catch (error) {
      console.error("Adjustments failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inventory/adjust", async (request, response) => {
    const { productId, adjustmentType, quantity, reason, unitName } = request.body;

    if (!productId || !adjustmentType || quantity === undefined || !reason) {
      return response.status(400).json({ error: "Product, type, quantity and reason are all required" });
    }

    // nothing moves for 0, so it is not recorded
    if (!Number.isFinite(Number(quantity)) || Number(quantity) < 1) {
      return response.status(400).json({ error: "The quantity has to be at least 1" });
    }

    // capped at the column width; empty means "keep what this material is counted in"
    let unit = "";
    if (typeof unitName === "string") {
      unit = unitName.trim().slice(0, 20);
    }

    try {
      const output = await callProcedure(
        "CALL sp_adjust_stock(?, ?, ?, ?, ?, ?, @status_code, @message)",
        [productId, adjustmentType, quantity, unit || null, reason, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({ message: output.message });
    } catch (error) {
      console.error("Stock adjust failed:", error.message);
      response.status(500).json({ error: "Unable to adjust the stock" });
    }
  });

  // REORDER POINT SETTINGS
  app.put("/api/inventory/reorder/:productId", async (request, response) => {
    const { reorderPoint } = request.body;

    if (reorderPoint === undefined || reorderPoint === null) {
      return response.status(400).json({ error: "A reorder point is required" });
    }

    try {
      const output = await callProcedure(
        "CALL sp_set_reorder_point(?, ?, ?, @status_code, @message)",
        [request.params.productId, reorderPoint, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({ message: output.message });
    } catch (error) {
      console.error("Reorder point failed:", error.message);
      response.status(500).json({ error: "Unable to save the reorder point" });
    }
  });

  // PURCHASE ORDERS
  app.get("/api/purchase-orders", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT po.po_id, po.status, po.order_date,
              po.confirmed_at, po.decision_note,
              po.supplier_sent_at, po.supplier_response, po.supplier_responded_at, po.supplier_note,
              po.supplier_ship_date,
              rb.full_name AS raised_by, cb.full_name AS confirmed_by,
              s.supplier_id, s.supplier_name, s.contact_person, s.contact_number,
              NULLIF(TRIM(s.email), '') AS supplier_email,
              COUNT(i.po_item_id) AS line_count,
              COALESCE(SUM(i.quantity), 0) AS total_units,
              COALESCE(SUM(i.line_cost), 0) AS goods_cost,
              po.discount,
              COALESCE(SUM(i.line_cost), 0) - po.discount AS total_cost
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       LEFT JOIN staff rb ON rb.staff_id = po.raised_by_staff_id
       LEFT JOIN staff cb ON cb.staff_id = po.confirmed_by_staff_id
       LEFT JOIN purchase_order_items i ON i.po_id = po.po_id
       GROUP BY po.po_id, po.status, po.order_date, po.confirmed_at, po.decision_note, po.discount,
                po.supplier_sent_at, po.supplier_response, po.supplier_responded_at, po.supplier_note,
                po.supplier_ship_date, rb.full_name, cb.full_name,
                s.supplier_id, s.supplier_name, s.contact_person, s.contact_number, s.email
       ORDER BY FIELD(po.status, 'For Approval', 'Pending', 'Received', 'Cancelled'), po.po_id DESC`
      );
      response.json(rows);
    } catch (error) {
      console.error("Purchase orders failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:poId/items", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT i.product_id, i.quantity, i.unit_cost, i.original_unit_cost, i.line_cost,
              i.pack_name, i.pack_size, i.pack_count,
              p.product_name, u.unit_name, c.category_name, b.brand_name,
              COALESCE(inv.quantity_in_stock, 0) AS quantity_in_stock
       FROM purchase_order_items i
       JOIN products p ON p.product_id = i.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       LEFT JOIN inventory inv ON inv.product_id = i.product_id
       WHERE i.po_id = ?
       ORDER BY i.po_item_id`,
        [request.params.poId]
      );
      response.json(rows);
    } catch (error) {
      console.error("PO items failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // The order as a document: the order, its lines and the shop, the way the
  // printed sheet, the PDF and the supplier's page all read it. Null when
  // there is no such order.
  async function readOrderDocument(poId) {
    const [orders] = await db.query(
      `SELECT po.po_id, po.status, po.order_date, po.confirmed_at,
              po.supplier_code, po.supplier_sent_at,
              po.supplier_response, po.supplier_responded_at, po.supplier_note, po.supplier_ship_date,
              po.discount,
              s.supplier_id, s.supplier_name, s.contact_person, s.contact_number,
              s.email AS supplier_email, s.address AS supplier_address,
              COALESCE(rb.full_name, st.full_name) AS raised_by,
              cb.full_name AS confirmed_by
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       LEFT JOIN staff rb ON rb.staff_id = po.raised_by_staff_id
       LEFT JOIN staff cb ON cb.staff_id = po.confirmed_by_staff_id
       LEFT JOIN audit_logs a ON a.action = 'PURCHASE_ORDER'
                             AND a.details LIKE CONCAT('PO #', po.po_id, ' %')
       LEFT JOIN staff st ON st.staff_id = a.staff_id
       WHERE po.po_id = ?
       LIMIT 1`,
      [poId]
    );
    if (orders.length === 0) return null;

    const [items] = await db.query(
      `SELECT i.po_item_id, i.product_id, i.quantity, i.unit_cost, i.original_unit_cost, i.line_cost,
              i.pack_name, i.pack_size, i.pack_count,
              p.product_name, u.unit_name, c.category_name, b.brand_name
       FROM purchase_order_items i
       JOIN products p ON p.product_id = i.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       WHERE i.po_id = ?
       ORDER BY i.po_item_id`,
      [poId]
    );

    const [settings] = await db.query(
      `SELECT store_name, address, tin, registration_type, invoice_note
       FROM store_settings WHERE setting_id = 1`
    );

    return { order: orders[0], items: items, shop: settings[0] || DEFAULT_STORE_SETTINGS };
  }

  // An approved order gets its supplier code when the manager approves it; an
  // order approved before codes existed gets one the first time it is printed
  // or sent. Never replaced, so every printed copy keeps working.
  async function ensureSupplierCode(poId) {
    await db.query(
      "UPDATE purchase_orders SET supplier_code = ? WHERE po_id = ? AND supplier_code IS NULL",
      [crypto.randomBytes(32).toString("base64url"), poId]);
  }

  // The supplier's link and its QR code (a PNG Buffer) for an approved order
  // waiting for its delivery; null otherwise, or with no web address to give.
  // The link goes to HARDWARE_SITE_URL, else to the address the request came in on.
  async function supplierAnswerLink(request, order) {
    if (order.status !== "Pending") return null;
    let code = order.supplier_code;
    if (!code) {
      await ensureSupplierCode(order.po_id);
      const [rows] = await db.query("SELECT supplier_code FROM purchase_orders WHERE po_id = ?", [order.po_id]);
      code = rows.length > 0 ? rows[0].supplier_code : null;
    }
    const link = supplierOrderLink(`${request.protocol}://${request.get("host")}`, code);
    if (!link) return null;
    return { link: link, qr: await qrPng(link) };
  }

  // The order as a printable document, assembled in one request. An approved
  // order carries the supplier's link and its QR code (a data URL) for the
  // printed sheet; the code itself is not handed out.
  app.get("/api/purchase-orders/:poId/document", async (request, response) => {
    try {
      const document = await readOrderDocument(request.params.poId);
      if (!document) {
        return response.status(404).json({ error: "That purchase order does not exist" });
      }
      const answer = await supplierAnswerLink(request, document.order);
      delete document.order.supplier_code;
      if (answer) {
        document.supplier_link = answer.link;
        document.supplier_qr = "data:image/png;base64," + answer.qr.toString("base64");
      }
      response.json(document);
    } catch (error) {
      console.error("PO document failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // Raising an order: the supplier arrives as a name and a line may name a new
  // material. The procedure creates whatever is new inside the order's transaction.
  app.post("/api/purchase-orders", async (request, response) => {
    const {
      supplierId, supplierName, contactPerson, contactNumber,
      supplierEmail, supplierAddress, items
    } = request.body;

    const company = String(supplierName || "").trim();

    if ((!supplierId && company === "") || !Array.isArray(items) || items.length === 0) {
      return response.status(400).json({
        error: "A supplier company name and at least one item are required"
      });
    }

    // the supplier's number is a Philippine mobile, stored as +639XXXXXXXXX;
    // letters, symbols and short or foreign numbers are refused. Blank is allowed.
    // only digits, spaces, dashes, brackets and a leading + belong in a number
    if (!/^\+?[\d\s\-()]*$/.test(String(contactNumber || "").trim())) {
      return response.status(400).json({
        error: "The contact number can only hold digits: 09XX XXX XXXX, or +63 9XX XXX XXXX."
      });
    }
    const phoneProblem = phoneComplaint(contactNumber);
    if (phoneProblem) {
      return response.status(400).json({ error: phoneProblem });
    }

    // only the fields the procedure reads, trimmed to their column widths
    const lines = [];
    for (const item of items) {
      lines.push({
        product_id: Number(item.productId || item.product_id) || null,
        quantity: Number(item.quantity) || 0,
        unit_cost: Number(firstGiven(item.unitCost, item.unit_cost)) || 0,
        new_name: shortText(item.newName || item.new_name, 150),
        brand_name: shortText(item.brandName || item.brand_name, 100),
        category_name: shortText(item.categoryName || item.category_name, 50),
        unit_name: shortText(item.unitName || item.unit_name, 20),
        // the pack the line was ordered in, if it was; the procedure drops a half-given one
        pack_name: shortText(item.packName || item.pack_name, 20),
        pack_size: Number(firstGiven(item.packSize, item.pack_size)) || null,
        pack_count: Number(firstGiven(item.packCount, item.pack_count)) || null,
        price: Number(item.price) || 0
      });
    }

    try {
      // the supplier is one on file: a new company is the manager's to add
      if (!Number(supplierId)) {
        const [known] = await db.query(
          "SELECT supplier_id FROM suppliers WHERE LOWER(supplier_name) = LOWER(?)", [company]);
        if (known.length === 0) {
          return response.status(400).json({
            error: `${company} is not on file. Only the manager can add a supplier; ` +
                   "ask the manager to add it under Records, then pick it here."
          });
        }
      }

      // a line naming a new material needs a category and a unit already on file
      const newLines = lines.filter((line) => !line.product_id);
      const onFile = await namesOnFile(newLines.map((line) => line.category_name),
                                       newLines.map((line) => line.unit_name));
      if (onFile.error) return response.status(400).json({ error: onFile.error });
      for (const line of newLines) {
        line.category_name = onFile.category(line.category_name);
        line.unit_name = onFile.unit(line.unit_name);
      }

      const output = await callProcedure(
        "CALL sp_create_purchase_order(?, ?, ?, ?, ?, ?, ?, ?, @po_id, @supplier_id_out, @new_materials, @status_code, @message)",
        [Number(supplierId) || null,
         company.slice(0, 100),
         String(contactPerson || "").trim().slice(0, 100),
         cleanPhone(contactNumber) || "",
         String(supplierEmail || "").trim().slice(0, 100),
         String(supplierAddress || "").trim(),
         JSON.stringify(lines),
         getActorId(request)],
        ["po_id", "supplier_id_out", "new_materials", "status_code", "message"]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({
        message: output.message,
        poId: output.po_id,
        supplierId: output.supplier_id_out,
        newMaterials: output.new_materials
      });
    } catch (error) {
      console.error("Create PO failed:", error.message);
      response.status(500).json({ error: "Unable to create the purchase order" });
    }
  });

  // The manager's decision on an order the clerk raised. Approved, it waits
  // for its delivery (Pending) and gets the supplier code its printed copy
  // carries; the clerk is told to print it and send it to the supplier
  // (sp_decide_purchase_order). Declined, it is Cancelled with the reason kept.
  app.post("/api/purchase-orders/:poId/decide", async (request, response) => {
    const body = request.body || {};
    const approve = body.approve === true;
    let note = "";
    if (typeof body.note === "string") {
      note = body.note.trim().slice(0, 255);
    }

    try {
      const poId = Number(request.params.poId);
      const output = await callProcedure(
        "CALL sp_decide_purchase_order(?, ?, ?, ?, @status_code, @message)",
        [poId, approve, note || null, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      if (!approve) {
        return response.json({ message: output.message, status: "Cancelled" });
      }

      await ensureSupplierCode(poId);
      response.json({
        message: `Purchase order #${poId} is approved. The clerk prints it and sends it to the supplier.`,
        status: "Pending"
      });
    } catch (error) {
      console.error("Purchase order decision failed:", error.message);
      response.status(500).json({ error: "Unable to record the decision" });
    }
  });

  // The clerk emails an approved order to its supplier: the printed order as
  // a PDF, with the link and QR code the supplier accepts or declines it
  // with. Printing it and handing it over is the other way; both carry the
  // same link. A supplier with no address, mail not set up, or a refusal from
  // the mail server each come back as a sentence saying to print it instead.
  app.post("/api/purchase-orders/:poId/send", async (request, response) => {
    const poId = Number(request.params.poId);

    try {
      const document = await readOrderDocument(poId);
      if (!document) return response.status(404).json({ error: "That purchase order does not exist" });

      const order = document.order;
      const number = "PO-" + String(order.po_id).padStart(6, "0");
      if (order.status !== "Pending") {
        return response.status(409).json({
          error: order.status === "For Approval"
            ? `${number} is not approved yet. The manager approves it before it goes to the supplier.`
            : `${number} is ${String(order.status).toLowerCase()}; there is nothing to send.`
        });
      }

      const email = String(order.supplier_email || "").trim();
      let problem = null;
      if (!email) {
        problem = `${order.supplier_name} has no email address on file. Print the order and send it to them.`;
      } else if (!isMailConfigured()) {
        problem = `Mail is not set up on this server. Print the order and send it to ${order.supplier_name}.`;
      }

      const answer = await supplierAnswerLink(request, order);
      if (!problem) {
        try {
          await sendMail(await purchaseOrderMessage({
            order: Object.assign({}, order, { supplier_email: email, order_date: order.confirmed_at || order.order_date }),
            items: document.items,
            shop: document.shop,
            link: answer ? answer.link : "",
            pdf: await purchaseOrderPdf(Object.assign({}, document,
              answer ? { link: answer.link, qr: answer.qr } : {}))
          }));
        } catch (error) {
          console.error(`Emailing ${number} to the supplier failed:`, error.message);
          problem = `The mail server refused ${number} for ${email}: ${error.message} ` +
                    "Print the order and send it to them.";
        }
      }

      if (problem) {
        await writeAuditLog(request, "PURCHASE_ORDER_NOT_SENT", `${number} not emailed to ${order.supplier_name}: ${problem}`,
          { po_id: order.po_id, supplier: order.supplier_name, email: email || null, emailed: false });
        return response.status(400).json({ error: problem });
      }

      await db.query("UPDATE purchase_orders SET supplier_sent_at = NOW() WHERE po_id = ?", [poId]);
      await writeAuditLog(request, "PURCHASE_ORDER_SENT", `${number} emailed to ${order.supplier_name} at ${email}`,
        { po_id: order.po_id, supplier: order.supplier_name, email: email, emailed: true });

      response.json({
        message: `${number} was emailed to ${order.supplier_name} at ${email}, with the PDF and the link ` +
                 "to accept or decline it.",
        linked: Boolean(answer)
      });
    } catch (error) {
      console.error("Sending the purchase order failed:", error.message);
      response.status(500).json({ error: "The order could not be sent. Print it and send it to the supplier." });
    }
  });

  // ==========================================
  // THE SUPPLIER'S PAGE (supplier-order.html) -- no account, only the link's code
  // ==========================================
  // The code is 32 random bytes, so it cannot be guessed; the access rules in
  // server.js let these three routes through without a session for that reason.
  // Gives back the order's document for a code, or null for an unknown one.
  async function orderForCode(code) {
    const [rows] = await db.query(
      "SELECT po_id FROM purchase_orders WHERE supplier_code = ?", [String(code)]);
    if (rows.length === 0) return null;
    return readOrderDocument(rows[0].po_id);
  }

  const UNKNOWN_LINK = "This link is not valid. Check it against the printed order, or contact the shop.";

  // what the supplier may see: the order, the lines and the shop, not the
  // shop's notes on it
  function supplierView(document) {
    const order = document.order;
    return {
      order: {
        po_id: order.po_id,
        number: "PO-" + String(order.po_id).padStart(6, "0"),
        status: order.status,
        order_date: order.confirmed_at || order.order_date,
        supplier_name: order.supplier_name,
        contact_person: order.contact_person,
        supplier_response: order.supplier_response,
        supplier_responded_at: order.supplier_responded_at,
        supplier_note: order.supplier_note,
        supplier_ship_date: order.supplier_ship_date,
        discount: order.discount,
        // only a placed order waiting for its delivery, answered once
        can_respond: order.status === "Pending" && !order.supplier_response
      },
      items: document.items.map((item) => ({
        id: item.po_item_id,
        product_name: item.product_name, brand_name: item.brand_name, category_name: item.category_name,
        quantity: item.quantity, unit_name: item.unit_name, unit_cost: item.unit_cost, line_cost: item.line_cost,
        original_unit_cost: item.original_unit_cost,
        pack_name: item.pack_name, pack_size: item.pack_size, pack_count: item.pack_count
      })),
      shop: { store_name: document.shop.store_name, address: document.shop.address }
    };
  }

  app.get("/api/supplier-order/:code", async (request, response) => {
    try {
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });
      response.json(supplierView(document));
    } catch (error) {
      console.error("Supplier order failed:", error.message);
      response.status(500).json({ error: "The order could not be opened. Try again in a moment." });
    }
  });

  app.get("/api/supplier-order/:code/pdf", async (request, response) => {
    try {
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });

      const number = "PO-" + String(document.order.po_id).padStart(6, "0");
      const answer = await supplierAnswerLink(request, document.order);
      const pdf = await purchaseOrderPdf(Object.assign({}, document,
        answer ? { link: answer.link, qr: answer.qr } : {}));
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Disposition", `inline; filename="${number}.pdf"`);
      response.send(pdf);
    } catch (error) {
      console.error("Supplier order PDF failed:", error.message);
      response.status(500).json({ error: "The PDF could not be made. Try again in a moment." });
    }
  });

  // The supplier's answer from the link on the order. Accepting, they say the
  // date it ships and may correct a price that does not match what they sell:
  // the corrected price goes on the line and the shop's own is kept beside it
  // (original_unit_cost). Declining, they say why. Answered once; the manager
  // and the clerk are told either way.
  const PRICE_CEILING = 100000000;   // unit_cost is DECIMAL(10,2)

  // today (plus some days) on the server's calendar, as YYYY-MM-DD
  function calendarDay(offsetDays) {
    const day = new Date();
    day.setDate(day.getDate() + offsetDays);
    return isoDay(day);
  }

  function isoDay(day) {
    return day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" +
           String(day.getDate()).padStart(2, "0");
  }

  // "Mon, Oct 12, 2026"
  function dayText(isoDate) {
    return new Date(isoDate + "T00:00:00").toLocaleDateString("en-PH",
      { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  function pesoText(value) {
    return "PHP " + Number(value || 0).toLocaleString("en-PH",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  app.post("/api/supplier-order/:code/respond", async (request, response) => {
    const body = request.body || {};
    const accept = body.accept === true;
    const note = String(body.note || "").trim().slice(0, 255);

    if (!accept && note.length < 5) {
      return response.status(400).json({ error: "Say why the order cannot be filled, so the shop can act on it." });
    }

    // a real calendar day, from tomorrow to a year out (2026-02-31 is refused:
    // it does not come back from Date as itself)
    let shipDate = null;
    if (accept) {
      shipDate = String(body.shipDate || "").trim();
      const parsed = new Date(shipDate + "T00:00:00");
      const real = /^\d{4}-\d{2}-\d{2}$/.test(shipDate) && !Number.isNaN(parsed.getTime()) &&
                   isoDay(parsed) === shipDate;
      if (!real) {
        return response.status(400).json({ error: "Pick the date the order will ship." });
      }
      if (shipDate <= calendarDay(0)) {
        return response.status(400).json({ error: "Pick a ship date after today." });
      }
      if (shipDate > calendarDay(365)) {
        return response.status(400).json({ error: "Pick a ship date within the next year." });
      }
    }

    let asked = [];
    if (accept && Array.isArray(body.prices)) asked = body.prices;

    let connection = null;
    try {
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });
      const order = document.order;
      const number = "PO-" + String(order.po_id).padStart(6, "0");

      // each corrected price, checked against this order's own lines
      const changes = [];
      for (const entry of asked) {
        const item = document.items.find((line) => Number(line.po_item_id) === Number(entry && entry.id));
        if (!item) {
          return response.status(400).json({
            error: "A price was sent for a line that is not on this order. Reload the page and try again." });
        }
        const price = Math.round(Number(entry.unitCost) * 100) / 100;
        if (!Number.isFinite(price) || price <= 0 || price >= PRICE_CEILING) {
          return response.status(400).json({ error: `Enter a price above zero for ${item.product_name}.` });
        }
        if (price !== Number(item.unit_cost) && !changes.some((change) => change.item === item)) {
          changes.push({ item: item, price: price });
        }
      }

      let before = 0;
      for (const item of document.items) before += Number(item.line_cost || 0);
      let after = before;
      for (const change of changes) {
        after += (change.price - Number(change.item.unit_cost)) * Number(change.item.quantity);
      }

      // a discount off the whole order, as a percentage or a peso amount; it
      // goes on the order's invoice discount, which receiving carries through
      let discount = 0;
      const offered = accept && body.discount ? body.discount : null;
      if (offered && offered.value !== undefined && offered.value !== null && String(offered.value).trim() !== "") {
        const value = Number(offered.value);
        const percent = offered.type === "percent";
        if (!Number.isFinite(value) || value < 0) {
          return response.status(400).json({ error: "The discount has to be zero or more." });
        }
        if (percent && value >= 100) {
          return response.status(400).json({ error: "A percentage discount has to be less than 100%." });
        }
        discount = Math.round((percent ? after * value / 100 : value) * 100) / 100;
        if (discount >= after) {
          return response.status(400).json({ error: "The discount has to be less than the order total." });
        }
      }

      // the answer and the prices land together or not at all
      connection = await db.getConnection();
      await connection.beginTransaction();

      // answered once, and only while the order waits for its delivery; the
      // WHERE makes two presses at once count as one
      const [result] = await connection.query(
        `UPDATE purchase_orders
         SET supplier_response = ?, supplier_responded_at = NOW(), supplier_note = ?, supplier_ship_date = ?,
             discount = CASE WHEN ? THEN ? ELSE discount END
         WHERE po_id = ? AND status = 'Pending' AND supplier_response IS NULL`,
        [accept ? "Accepted" : "Declined", note || null, shipDate, accept, discount, order.po_id]);

      if (result.affectedRows === 0) {
        await connection.rollback();
        connection.release();
        connection = null;
        const again = await readOrderDocument(order.po_id);
        let why = `${number} can no longer be answered here: it is ${String(again.order.status).toLowerCase()}.`;
        if (again.order.supplier_response) {
          why = `${number} was already ${again.order.supplier_response.toLowerCase()}. Contact the shop to change it.`;
        }
        return response.status(409).json({ error: why, view: supplierView(again) });
      }

      for (const change of changes) {
        await connection.query(
          `UPDATE purchase_order_items
           SET original_unit_cost = COALESCE(original_unit_cost, unit_cost), unit_cost = ?
           WHERE po_item_id = ? AND po_id = ?`,
          [change.price, change.item.po_item_id, order.po_id]);
      }

      await connection.commit();
      connection.release();
      connection = null;

      // the manager and the clerk are told at once, on the bell
      let title = `${order.supplier_name} accepted purchase order #${order.po_id}`;
      let message = `${order.supplier_name} accepted ${number} and will ship it on ${dayText(shipDate)}.`;
      if (changes.length > 0) {
        title = `${order.supplier_name} accepted purchase order #${order.po_id} with new prices`;
        message += ` They changed the price on ${changes.length} ${changes.length === 1 ? "line" : "lines"}: ` +
                   changes.map((change) => `${change.item.product_name} ${pesoText(change.item.unit_cost)} to ` +
                     pesoText(change.price)).join("; ") +
                   `. Order total ${pesoText(before)} to ${pesoText(after)}.`;
      }
      if (discount > 0) {
        message += ` They gave a discount of ${pesoText(discount)}, so the order comes to ${pesoText(after - discount)}.`;
      }
      if (note) message += ` Their note: ${note}`;
      if (!accept) {
        title = `${order.supplier_name} cannot fill purchase order #${order.po_id}`;
        message = `${order.supplier_name} declined ${number}: ${note} Order the materials elsewhere, ` +
                  "or contact the supplier.";
      }
      await db.query(
        `INSERT INTO notifications (target_role_id, notif_type, title, message)
         SELECT role_id, 'Purchase Order', ?, ? FROM roles WHERE role_name IN ('Manager', 'Inventory Clerk')`,
        [title.slice(0, 150), message]);

      let details = `${number} declined by ${order.supplier_name} from the link on the order: ${note}`;
      if (accept) {
        details = `${number} accepted by ${order.supplier_name} from the link on the order, shipping ${shipDate}` +
          (changes.length > 0
            ? `, ${changes.length} price(s) changed, total ${pesoText(before)} to ${pesoText(after)}`
            : "") +
          (discount > 0 ? `, discount ${pesoText(discount)}` : "") +
          (note ? `: ${note}` : "");
      }
      await writeAuditLog(request, accept ? "PURCHASE_ORDER_ACCEPTED" : "PURCHASE_ORDER_DECLINED_BY_SUPPLIER",
        details,
        { po_id: order.po_id, supplier: order.supplier_name, accepted: accept, ship_date: shipDate, discount: discount,
          prices: changes.map((change) => ({ product: change.item.product_name,
            from: Number(change.item.unit_cost), to: change.price })) });

      // the bell and the order list update without a reload
      if (publishChange) {
        publishChange("notifications", `supplier answered ${number}`, null);
        publishChange("inventory", `supplier answered ${number}`, null);
      }

      response.json({
        message: accept
          ? `Thank you. ${number} is accepted, and ${document.shop.store_name || "the shop"} has been told.`
          : `Thank you. ${document.shop.store_name || "The shop"} has been told that ${number} cannot be filled.`,
        view: supplierView(await readOrderDocument(order.po_id))
      });
    } catch (error) {
      if (connection) {
        await connection.rollback().catch(() => {});
        connection.release();
      }
      console.error("Supplier response failed:", error.message);
      response.status(500).json({ error: "Your answer could not be saved. Try again in a moment." });
    }
  });

  // Receiving, by the clerk once the manager has confirmed the order: the
  // body carries the count sheet, including anything never ordered. An empty
  // body receives the order exactly as written.
  app.post("/api/purchase-orders/:poId/receive", async (request, response) => {
    let received;
    if (Array.isArray(request.body && request.body.received)) {
      received = request.body.received;
    } else {
      received = [];
    }

    // what was actually counted in, line by line
    const sheet = [];
    for (const line of received) {
      sheet.push({
        product_id: Number(line.productId || line.product_id) || null,
        quantity: Math.max(0, Number(line.quantity) || 0),
        unit_cost: Number(firstGiven(line.unitCost, line.unit_cost)) || 0,
        new_name: shortText(line.newName || line.new_name, 150),
        brand_name: shortText(line.brandName || line.brand_name, 100),
        category_name: shortText(line.categoryName || line.category_name, 50),
        unit_name: shortText(line.unitName || line.unit_name, 20)
      });
    }

    // the supplier's discount off the invoice, if any (never below 0)
    const body = request.body || {};
    const discount = Math.max(0, Number(body.discount) || 0);

    try {
      const output = await callProcedure(
        "CALL sp_receive_purchase_order(?, ?, ?, ?, @lines, @extras, @status_code, @message)",
        [request.params.poId, JSON.stringify(sheet), discount, getActorId(request)],
        ["lines", "extras", "status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({ message: output.message, lines: output.lines, extras: output.extras });
    } catch (error) {
      console.error("Receive PO failed:", error.message);
      response.status(500).json({ error: "Unable to receive the purchase order" });
    }
  });

  // RETURNS, DAMAGE AND REFUND REPORTS
  app.get("/api/returns", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT r.return_id, r.report_type, r.quantity, r.reason, r.refund_amount,
              r.restocked, r.disposition, r.status, r.return_date, r.sale_id,
              r.inspected_at, r.inspection_note,
              (r.status = 'Open' AND r.disposition IS NULL) AS awaiting_inspection,
              p.product_id, p.product_name, u.unit_name,
              COALESCE(s.full_name, 'Unknown') AS reported_by,
              i.full_name AS inspected_by
       FROM returned_items r
       JOIN products p ON p.product_id = r.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN staff s ON s.staff_id = r.reported_by_staff_id
       LEFT JOIN staff i ON i.staff_id = r.inspected_by_staff_id
       ORDER BY FIELD(r.status, 'Open', 'Resolved'), r.disposition IS NOT NULL, r.return_id DESC`
      );
      response.json(rows);
    } catch (error) {
      console.error("Returns failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // Filing a return: a reason (a sentence) is compulsory. So is a disposition,
  // except on a refund from the counter, which the clerk inspects before it
  // is decided: a cashier never says where the goods go, whatever is sent.
  // restock is still accepted from older callers and mapped across.
  const RETURN_DISPOSITIONS = ["Return to Stock", "Write-Off"];
  const MINIMUM_RETURN_REASON = 10;

  app.post("/api/returns", async (request, response) => {
    const { productId, saleId, reportType, quantity, reason, refundAmount,
            disposition, restock } = request.body;

    if (!productId || !reportType || !quantity) {
      return response.status(400).json({ error: "Product, type and quantity are all required" });
    }

    let explanation = "";
    if (typeof reason === "string") {
      explanation = reason.trim();
    }
    if (explanation.length < MINIMUM_RETURN_REASON) {
      return response.status(400).json({
        error: "Say what happened, in a sentence. A write-off queried three months " +
               "from now has to be explainable from this line alone."
      });
    }

    const fromCounter = request.actor && request.actor.roleName === CASHIER;
    let where;
    if (fromCounter) {
      where = null;
    } else if (RETURN_DISPOSITIONS.includes(disposition)) {
      where = disposition;
    } else if (restock === true) {
      where = "Return to Stock";
    } else {
      where = null;
    }

    // the procedure lets a Refunded report wait for inspection; anything else needs the words
    if (!where && !(reportType === "Refunded")) {
      return response.status(400).json({
        error: "Say where the goods go: Return to Stock, or Write-Off."
      });
    }

    try {
      const output = await callProcedure(
        "CALL sp_file_return_report(?, ?, ?, ?, ?, ?, ?, ?, @report_id, @status_code, @message)",
        [productId, saleId || null, reportType, quantity, explanation,
         refundAmount || 0, where, getActorId(request)],
        ["report_id", "status_code", "message"]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      let action = "RETURN";
      if (reportType === "Refunded") {
        action = "REFUND";
      }
      await writeAuditLog(
        request,
        action,
        `${reportType} #${output.report_id}: ${quantity} unit(s), ${where || "awaiting inspection"}`,
        {
          report_id: output.report_id,
          product_id: Number(productId),
          sale_id: saleId || null,
          quantity: Number(quantity),
          disposition: where,
          refund_amount: Number(refundAmount || 0),
          reason: explanation
        }
      );

      response.json({ message: output.message, reportId: output.report_id, disposition: where,
                      awaitingInspection: where === null });
    } catch (error) {
      console.error("File report failed:", error.message);
      response.status(500).json({ error: "Unable to file the report" });
    }
  });

  // The clerk's verdict on a refund from the counter: Return to Stock if it
  // can be sold again, Write-Off if not, with a note. A report that was
  // decided at filing is simply closed.
  app.post("/api/returns/:reportId/resolve", async (request, response) => {
    const body = request.body || {};
    let verdict = null;
    if (RETURN_DISPOSITIONS.includes(body.disposition)) {
      verdict = body.disposition;
    }
    let note = "";
    if (typeof body.note === "string") {
      note = body.note.trim().slice(0, 255);
    }

    try {
      const output = await callProcedure(
        "CALL sp_resolve_return_report(?, ?, ?, ?, @status_code, @message)",
        [request.params.reportId, verdict, note || null, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      if (verdict) {
        let details = `Report #${request.params.reportId} inspected: ${verdict}`;
        if (note) {
          details += " - " + note;
        }
        await writeAuditLog(request, "RETURN_INSPECTED", details,
          { report_id: Number(request.params.reportId), disposition: verdict, note: note || null });
      }

      response.json({ message: output.message, disposition: verdict });
    } catch (error) {
      console.error("Resolve report failed:", error.message);
      response.status(500).json({ error: "Unable to resolve the report" });
    }
  });

  // NOTIFICATIONS -- which alerts you see is decided by the role on your session
  app.get("/api/notifications", async (request, response) => {
    const roleId = request.actor.roleId;

    try {
      const [rows] = await db.query(
        `SELECT n.notification_id, n.notif_type, n.title, n.message, n.is_read, n.created_at,
              n.product_id, p.product_name,
              COALESCE(s.full_name, 'System') AS from_name,
              COALESCE(r.role_name, 'Automatic') AS from_role
       FROM notifications n
       LEFT JOIN products p ON p.product_id = n.product_id
       LEFT JOIN staff s ON s.staff_id = n.created_by_staff_id
       LEFT JOIN roles r ON r.role_id = s.role_id
       WHERE n.target_role_id IS NULL OR n.target_role_id = ?
       ORDER BY n.is_read, n.notification_id DESC
       LIMIT 60`,
        [roleId]
      );
      response.json(rows);
    } catch (error) {
      console.error("Notifications failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/notifications/:notificationId/read", async (request, response) => {
    try {
      await db.query(
        `UPDATE notifications SET is_read = TRUE
       WHERE notification_id = ? AND (target_role_id IS NULL OR target_role_id = ?)`,
        [request.params.notificationId, request.actor.roleId]
      );
      response.json({ message: "Marked as read" });
    } catch (error) {
      console.error("Mark read failed:", error.message);
      response.status(500).json({ error: "Unable to mark it read" });
    }
  });

  app.post("/api/notifications/read-all", async (request, response) => {
    const roleId = request.actor.roleId;

    try {
      await db.query(
        "UPDATE notifications SET is_read = TRUE WHERE target_role_id IS NULL OR target_role_id = ?",
        [roleId]
      );
      response.json({ message: "All notifications marked as read" });
    } catch (error) {
      console.error("Mark all read failed:", error.message);
      response.status(500).json({ error: "Unable to mark them read" });
    }
  });
}

module.exports = { registerInventoryRoutes };
