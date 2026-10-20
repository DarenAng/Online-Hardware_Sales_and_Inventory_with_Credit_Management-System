// ============================================================
// inventory-clerk.js -- Inventory module (inventory clerk)
// Loaded by: server.js only (from the routes folder). Never sent to a browser.
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
// rules in access-control.js have already checked the user's role.
// ============================================================
const crypto = require("crypto");
const mailer = require("../services/mailer");
const inventoryClerkProcedures = require("../database/procedures/inventory-clerk-procedures");
const isMailConfigured = mailer.isMailConfigured;
const sendMail = mailer.sendMail;
const purchaseOrderMessage = mailer.purchaseOrderMessage;
const supplierOrderLink = mailer.supplierOrderLink;
const qrPng = mailer.qrPng;
const purchaseOrderPdf = require("../services/purchase-order-pdf").purchaseOrderPdf;

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
  // ends with a consonant + "ies" (batteries -> battery)
  if (/[^aeiou]ies$/.test(name)) return name.slice(0, -3) + "y";
  // ends with s, x, z, ch or sh + "es" (boxes -> box)
  if (/(s|x|z|ch|sh)es$/.test(name)) return name.slice(0, -2);
  // ends with a single "s" that does not follow another "s" (liters -> liter)
  if (/[^s]s$/.test(name)) return name.slice(0, -1);
  return name;
}

function registerInventoryRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const writeAuditLog = deps.writeAuditLog;
  const fieldChanges = deps.fieldChanges;
  const DEFAULT_STORE_SETTINGS = deps.DEFAULT_STORE_SETTINGS;
  const CASHIER = deps.CASHIER;
  const DRIVER = deps.DRIVER;
  const phoneComplaint = deps.phoneComplaint;
  const cleanPhone = deps.cleanPhone;
  const publishChange = deps.publishChange;

  // ==========================================
  // INVENTORY MODULE
  // ==========================================

  // headline numbers for the clerk dashboard
  app.get("/api/inventory/summary", async function (request, response) {
    try {
      const stockRowsResult = await db.query(
        "SELECT COUNT(*) AS product_count, " +
        "COALESCE(SUM(CASE WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock, " +
        "COALESCE(SUM(CASE WHEN COALESCE(i.quantity_in_stock, 0) > 0 " +
        "AND COALESCE(i.quantity_in_stock, 0) <= p.reorder_point THEN 1 ELSE 0 END), 0) AS low_stock, " +
        "COALESCE(SUM(COALESCE(i.quantity_in_stock, 0) * p.price), 0) AS stock_value " +
        "FROM products p " +
        "LEFT JOIN inventory i ON i.product_id = p.product_id " +
        "WHERE p.is_archived = FALSE"
      );
      const stockRows = stockRowsResult[0];
      const stock = stockRows[0];
      const poRowsResult = await db.query(
        "SELECT COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending_po, " +
        "COUNT(*) AS total_po " +
        "FROM purchase_orders"
      );
      const poRows = poRowsResult[0];
      const po = poRows[0];
      const repRowsResult = await db.query(
        "SELECT COALESCE(SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END), 0) AS open_reports, " +
        "COALESCE(SUM(CASE WHEN report_type = 'Damaged' THEN quantity ELSE 0 END), 0) AS damaged_units, " +
        "COALESCE(SUM(refund_amount), 0) AS refunded_total " +
        "FROM returned_items"
      );
      const repRows = repRowsResult[0];
      const rep = repRows[0];
      const archRowsResult = await db.query(
        "SELECT COUNT(*) AS archived FROM products WHERE is_archived = TRUE"
      );
      const archRows = archRowsResult[0];

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

  app.get("/api/inventory/products", async function (request, response) {
    const archived = request.query.archived === "true";

    try {
      const rowsResult = await db.query(
        "SELECT p.product_id, p.product_name, p.price, p.reorder_point, p.status, " +
        "p.pack_name, p.pack_size, " +
        "p.is_archived, p.archived_at, p.created_at, " +
        "COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock, " +
        "i.last_updated, " +
        "c.category_name, b.brand_name, u.unit_name, " +
        "sup.supplier_id, sup.supplier_name, sup.contact_person, sup.contact_number, " +
        "NULLIF(TRIM(sup.email), '') AS supplier_email, " +
        "NULLIF(TRIM(sup.address), '') AS supplier_address, " +
        "(COALESCE(i.quantity_in_stock, 0) * p.price) AS stock_value, " +
        "CASE " +
        "WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 'Out of Stock' " +
        "WHEN COALESCE(i.quantity_in_stock, 0) <= p.reorder_point THEN 'Low Stock' " +
        "ELSE 'In Stock' " +
        "END AS stock_status, " +
        "GREATEST((p.reorder_point * 2) - COALESCE(i.quantity_in_stock, 0), 0) AS suggested_order, " +
        "COALESCE(ar.full_name, '') AS archived_by, " +
        "(SELECT JSON_ARRAYAGG(JSON_OBJECT( " +
        "'product_unit_id', pu.product_unit_id, 'unit_name', pu.unit_name, " +
        "'units_per', pu.units_per, 'price', pu.price)) " +
        "FROM product_units pu WHERE pu.product_id = p.product_id) AS selling_units " +
        "FROM products p " +
        "LEFT JOIN inventory i ON i.product_id = p.product_id " +
        "LEFT JOIN categories c ON c.category_id = p.category_id " +
        "LEFT JOIN brands b ON b.brand_id = p.brand_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id " +
        "LEFT JOIN staff ar ON ar.staff_id = p.archived_by_staff_id " +
        "WHERE p.is_archived = ? " +
        "ORDER BY (COALESCE(i.quantity_in_stock, 0) <= p.reorder_point) DESC, p.product_name",
        [archived]
      );
      const rows = rowsResult[0];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        row.selling_units = sellingUnitsOf(row.selling_units);
      }
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
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
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
    const rowsResult = await db.query(
      "SELECT product_unit_id, product_id, unit_name, units_per, price, created_at " +
      "FROM product_units WHERE product_id = ? ORDER BY units_per, unit_name",
      [productId]);
    const rows = rowsResult[0];
    return rows;
  }

  app.get("/api/inventory/products/:productId/units", async function (request, response) {
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
  app.post("/api/inventory/products/:productId/units", async function (request, response) {
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
    // a size priced at 0 would sell for nothing, so 0 is treated like an empty box:
    // the price is worked out from the product's own price
    if (price === 0) price = null;

    try {
      const productsResult = await db.query(
        "SELECT p.product_id, p.product_name, p.price, u.unit_name " +
        "FROM products p LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE p.product_id = ?", [productId]);
      const products = productsResult[0];
      if (products.length === 0) return response.status(404).json({ error: "That material was not found." });
      const product = products[0];

      // the manager prices products; a size price on a product with no price would be ahead of it
      if (price !== null && !(Number(product.price) > 0)) {
        return response.status(400).json({
          error: product.product_name + " has no price yet. Set the product's price first (the manager does that), " +
                 "then give a size its own price."
        });
      }

      if (product.unit_name && product.unit_name.toLowerCase() === unitName.toLowerCase()) {
        return response.status(400).json({
          error: product.product_name + " is already kept by the " + product.unit_name + "; add a bigger size, like box or sack."
        });
      }

      await db.query(
        "INSERT INTO product_units (product_id, unit_name, units_per, price) " +
        "VALUES (?, ?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE units_per = VALUES(units_per), price = VALUES(price)",
        [productId, unitName, unitsPer, price]);

      // the price of one of this size (worked out from the unit price when none was given)
      let each = price;
      if (price === null) {
        each = Math.round(Number(product.price) * unitsPer * 100) / 100;
      }
      await writeAuditLog(request, "UPDATE_SELLING_UNIT",
        product.product_name + " sells by the " + unitName + ": " + unitsPer + " " + (product.unit_name || "") + " at " + each.toFixed(2),
        { product_id: productId, unit_name: unitName, units_per: unitsPer, price: price });

      response.json({
        message: product.product_name + " now sells by the " + unitName + " (" + unitsPer + " " + (product.unit_name || "units") + ").",
        units: await listSellingUnits(productId)
      });
    } catch (error) {
      console.error("Saving a selling unit failed:", error.message);
      response.status(500).json({ error: "Unable to save that size" });
    }
  });

  // Sales already written in a size keep their own copy of it (sale_items.sold_unit),
  // so taking a size off the list changes nothing that has been sold.
  app.delete("/api/inventory/products/:productId/units/:unitId", async function (request, response) {
    const productId = Number(request.params.productId);
    const unitId = Number(request.params.unitId);

    try {
      const rowsResult = await db.query(
        "SELECT pu.unit_name, p.product_name FROM product_units pu " +
        "JOIN products p ON p.product_id = pu.product_id " +
        "WHERE pu.product_unit_id = ? AND pu.product_id = ?", [unitId, productId]);
      const rows = rowsResult[0];
      if (rows.length === 0) return response.status(404).json({ error: "That size is not on the list." });

      await db.query("DELETE FROM product_units WHERE product_unit_id = ?", [unitId]);

      await writeAuditLog(request, "REMOVE_SELLING_UNIT",
        rows[0].product_name + " no longer sells by the " + rows[0].unit_name,
        { product_id: productId, unit_name: rows[0].unit_name });

      response.json({
        message: rows[0].product_name + " no longer sells by the " + rows[0].unit_name + ".",
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
      return { error: "The category \"" + categories.missing + "\" is not on file. Only the manager can add a category; " +
                      "pick one on the list, or ask the manager to add it under Records." };
    }

    const units = await matchOnFile("SELECT unit_name AS name FROM units", unitNames);
    if (units.missing) {
      return { error: "The unit \"" + units.missing + "\" is not on file. Only the manager can add a unit; " +
                      "pick one on the list, or ask the manager to add it under Records." };
    }

    return { category: categories.onFile, unit: units.onFile };
  }

  async function matchOnFile(sql, typedNames) {
    // the names that were typed, trimmed, with the blanks left out
    const typed = [];
    for (let i = 0; i < typedNames.length; i++) {
      const text = String(typedNames[i] || "").trim();
      if (text !== "") typed.push(text);
    }
    // what was typed (in loose form) -> the name on file, one { key, name } for each
    const matches = [];
    if (typed.length === 0) return { onFile: function (value) { return value; } };

    const rowsResult = await db.query(sql);
    const rows = rowsResult[0];
    for (let i = 0; i < typed.length; i++) {
      const value = typed[i];
      // the same spelling first, so "Liter" never loses to a "Liters" also on file
      let same = null;
      for (let r = 0; r < rows.length; r++) {
        if (looseName(rows[r].name) === looseName(value)) {
          same = rows[r];
          break;
        }
      }
      if (!same) {
        for (let r = 0; r < rows.length; r++) {
          if (singularName(rows[r].name) === singularName(value)) {
            same = rows[r];
            break;
          }
        }
      }
      if (!same) return { missing: value };
      matches.push({ key: looseName(value), name: same.name });
    }

    return {
      onFile: function (value) {
        const text = String(value || "").trim();
        if (text === "") return value;
        const key = looseName(text);
        for (let i = 0; i < matches.length; i++) {
          if (matches[i].key === key) return matches[i].name || text;
        }
        return text;
      }
    };
  }

  // Adding a product from the Material List: its category and unit must already
  // be on file; a new brand is created alongside it. It starts with no price
  // (price 0 means "no price set"): the clerk counts, the manager prices, so
  // the price is not read from the request. The manager is told, and the till
  // will not sell it until it has a price. An existing name returns the
  // existing material, and the answer says so (created: false).
  app.post("/api/materials", async function (request, response) {
    const body = request.body || {};
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    const brandName = String(body.brandName || "").trim();
    const categoryName = String(body.categoryName || "").trim();
    const unitName = String(body.unitName || "").trim();
    const supplierId = Number(body.supplierId) || null;

    if (name === "") {
      return response.status(400).json({ error: "A product needs a name." });
    }
    if (name.length > 150) {
      return response.status(400).json({ error: "A product name is at most 150 characters." });
    }
    if (brandName.length > 100) {
      return response.status(400).json({ error: "A brand name is at most 100 characters." });
    }
    if (categoryName === "") {
      return response.status(400).json({ error: "Pick the product's category." });
    }
    if (unitName === "") {
      return response.status(400).json({ error: "Pick the unit the product is counted in." });
    }

    // the reorder point is optional; left blank, the procedure's own default stays
    let reorderPoint = null;
    if (body.reorderPoint !== undefined && body.reorderPoint !== null && String(body.reorderPoint).trim() !== "") {
      reorderPoint = Number(body.reorderPoint);
      if (!Number.isInteger(reorderPoint) || reorderPoint < 0 || reorderPoint > 100000) {
        return response.status(400).json({ error: "The reorder point has to be a whole number from 0 to 100000." });
      }
    }

    try {
      const onFile = await namesOnFile([categoryName], [unitName]);
      if (onFile.error) return response.status(400).json({ error: onFile.error });

      if (supplierId !== null) {
        const supplierResult = await db.query("SELECT supplier_id FROM suppliers WHERE supplier_id = ?", [supplierId]);
        if (supplierResult[0].length === 0) {
          return response.status(400).json({ error: "That supplier is not on file. Pick one from the list." });
        }
      }

      // Two clerks adding the same new name together would both find it missing and make
      // two records, so adding takes turns: a named MySQL lock, held on its own connection
      // while the procedure runs (the same way migrations.js makes copies take turns).
      let output;
      const lockConnection = await db.getConnection();
      try {
        const lockedResult = await lockConnection.query("SELECT GET_LOCK('add-product', 10) AS got");
        if (Number(lockedResult[0][0].got) !== 1) {
          return response.status(503).json({ error: "Another product is being added right now. Try again in a moment." });
        }
        try {
          output = await inventoryClerkProcedures.createMaterial(
            [name, brandName, String(onFile.category(categoryName) || "").slice(0, 50),
             String(onFile.unit(unitName) || "").slice(0, 20),
             0, supplierId, getActorId(request)]
          );
        } finally {
          await lockConnection.query("SELECT RELEASE_LOCK('add-product')");
        }
      } finally {
        lockConnection.release();
      }

      if (output.status_code !== 201 && output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      const productId = output.product_id;

      // the name was already on file: say so, and say where it is (the
      // procedure also finds a product that was put away in the Archive)
      if (output.status_code === 200) {
        const sameResult = await db.query(
          "SELECT product_name, is_archived FROM products WHERE product_id = ?", [productId]);
        const same = sameResult[0][0];
        const sameName = same ? same.product_name : name;
        let message = "\"" + sameName + "\" is already on the material list. Nothing was added.";
        if (same && same.is_archived) {
          message = "\"" + sameName + "\" is already on file but was put away in the Archive. " +
                    "Restore it from the Archive screen instead of adding it again.";
        }
        return response.json({ message: message, productId: productId, created: false, archived: Boolean(same && same.is_archived) });
      }

      // the product is already saved: a failure here keeps the default reorder point and the add still stands
      if (reorderPoint !== null) {
        try {
          await db.query("UPDATE products SET reorder_point = ? WHERE product_id = ?", [reorderPoint, productId]);
        } catch (error) {
          console.error("The product was added, but its reorder point was not saved:", error.message);
        }
      }

      // the manager is told, in the bell, so the price gets set
      try {
        const clerkResult = await db.query("SELECT full_name FROM staff WHERE staff_id = ?", [getActorId(request)]);
        let clerkName = "the inventory clerk";
        if (clerkResult[0].length > 0 && clerkResult[0][0].full_name) clerkName = clerkResult[0][0].full_name;

        await db.query(
          "INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id) " +
          "SELECT role_id, 'New Product', ?, ?, ?, ? FROM roles WHERE role_name = 'Manager'",
          [("New product added: " + name + " by " + clerkName).slice(0, 150),
           name + " was added to the material list and has no price yet. Set its price under Stocks Overview; " +
           "until then the till cannot sell it.",
           productId, getActorId(request)]);
      } catch (error) {
        console.error("The product was added, but telling the manager failed:", error.message);
      }

      // the inventory scope goes out by itself on this address (scopeOf in live-changes.js)
      publishChange("notifications", "new product " + productId, request.headers["x-client-id"] || null);

      response.json({
        message: name + " was added to the material list with no price. The manager has been told to set it.",
        productId: productId,
        created: true
      });
    } catch (error) {
      console.error("Create material failed:", error.message);
      response.status(500).json({ error: "Unable to add the product" });
    }
  });

  // STOCK ADJUSTMENT
  // Units: a unit typed on an adjustment is added; the same clerk can rename
  // one, and renaming onto an existing name merges.
  // How a material is delivered: a "box" of 20 of its unit. Blank clears it.
  // Orders and deliveries are then counted in that pack; stock stays in the unit.
  app.put("/api/inventory/products/:productId/pack", async function (request, response) {
    const productId = Number(request.params.productId);
    const body = request.body || {};
    const name = String(body.packName || "").trim().slice(0, 20);
    const size = Number(body.packSize);

    if (name !== "" && (!Number.isFinite(size) || size <= 0)) {
      return response.status(400).json({ error: "Say how much of the unit one pack holds, like 20." });
    }

    try {
      const rowsResult = await db.query(
        "SELECT p.product_name, p.pack_name, p.pack_size, u.unit_name " +
        "FROM products p LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE p.product_id = ?", [productId]);
      const rows = rowsResult[0];
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
        message = before.product_name + " is delivered by the " + name + " of " + packSize + " " + unit + ".";
      } else {
        message = before.product_name + " is delivered by the " + unit + " again.";
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

  app.put("/api/units/:unitId", async function (request, response) {
    const unitName = request.body.unitName;

    if (!unitName || String(unitName).trim() === "") {
      return response.status(400).json({ error: "A unit needs a name" });
    }

    try {
      const output = await inventoryClerkProcedures.renameUnit(
        [request.params.unitId, String(unitName).trim().slice(0, 20), getActorId(request)]
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

  app.get("/api/inventory/adjustments", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT a.adjustment_id, a.adjustment_type, a.quantity_before, a.quantity_change, " +
        "a.quantity_after, a.reason, a.created_at, " +
        "p.product_name, " +
        "-- What the entry itself says it counted, falling back to the\n" +
        "-- material's unit today only for entries filed before the log\n" +
        "-- recorded one. The entry's own answer always wins: renaming a\n" +
        "-- unit must not rewrite what last year's rows say they counted.\n" +
        "COALESCE(NULLIF(TRIM(a.unit_name), ''), u.unit_name) AS unit_name, " +
        "u.unit_name AS current_unit, " +
        "COALESCE(s.full_name, 'System') AS adjusted_by " +
        "FROM stock_adjustments a " +
        "JOIN products p ON p.product_id = a.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "LEFT JOIN staff s ON s.staff_id = a.adjusted_by_staff_id " +
        "ORDER BY a.adjustment_id DESC " +
        "LIMIT 200"
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      console.error("Adjustments failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inventory/adjust", async function (request, response) {
    const productId = request.body.productId;
    const adjustmentType = request.body.adjustmentType;
    const quantity = request.body.quantity;
    const reason = request.body.reason;
    const unitName = request.body.unitName;

    if (!productId || !adjustmentType || quantity === undefined || quantity === null || quantity === "" || !reason) {
      return response.status(400).json({ error: "Product, type, quantity and reason are all required" });
    }

    // Add and Remove move the shelf, so 0 is not an adjustment (fractions are
    // fine: 0.5 kg). A recount may find the shelf empty, so it may be 0.
    // The same words are in sp_adjust_stock and in the Stock Adjustment form.
    if (!Number.isFinite(Number(quantity))) {
      return response.status(400).json({ error: "The quantity must be a number." });
    }
    if (adjustmentType === "Recount") {
      if (Number(quantity) < 0) {
        return response.status(400).json({ error: "A recount cannot be below zero." });
      }
    } else if (Number(quantity) <= 0) {
      return response.status(400).json({ error: "Add and Remove need a quantity greater than zero." });
    }

    // capped at the column width; empty means "keep what this material is counted in"
    let unit = "";
    if (typeof unitName === "string") {
      unit = unitName.trim().slice(0, 20);
    }

    try {
      const output = await inventoryClerkProcedures.adjustStock(
        [productId, adjustmentType, quantity, unit || null, reason, getActorId(request)]
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
  app.put("/api/inventory/reorder/:productId", async function (request, response) {
    const reorderPoint = request.body.reorderPoint;

    if (reorderPoint === undefined || reorderPoint === null) {
      return response.status(400).json({ error: "A reorder point is required" });
    }

    try {
      const output = await inventoryClerkProcedures.setReorderPoint(
        [request.params.productId, reorderPoint, getActorId(request)]
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
  app.get("/api/purchase-orders", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT po.po_id, po.status, po.order_date, " +
        "po.confirmed_at, po.decision_note, po.received_at, " +
        "po.supplier_sent_at, po.supplier_response, po.supplier_responded_at, po.supplier_note, " +
        "po.supplier_ship_date, " +
        "rb.full_name AS raised_by, cb.full_name AS confirmed_by, " +
        "s.supplier_id, s.supplier_name, s.contact_person, s.contact_number, " +
        "NULLIF(TRIM(s.email), '') AS supplier_email, " +
        "COUNT(i.po_item_id) AS line_count, " +
        "COALESCE(SUM(i.quantity), 0) AS total_units, " +
        "COALESCE(SUM(i.line_cost), 0) AS goods_cost, " +
        "po.discount, " +
        "COALESCE(SUM(i.line_cost), 0) - po.discount AS total_cost " +
        "FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id " +
        "LEFT JOIN staff rb ON rb.staff_id = po.raised_by_staff_id " +
        "LEFT JOIN staff cb ON cb.staff_id = po.confirmed_by_staff_id " +
        "LEFT JOIN purchase_order_items i ON i.po_id = po.po_id " +
        "GROUP BY po.po_id, po.status, po.order_date, po.confirmed_at, po.decision_note, po.received_at, po.discount, " +
        "po.supplier_sent_at, po.supplier_response, po.supplier_responded_at, po.supplier_note, " +
        "po.supplier_ship_date, rb.full_name, cb.full_name, " +
        "s.supplier_id, s.supplier_name, s.contact_person, s.contact_number, s.email " +
        "ORDER BY FIELD(po.status, 'For Approval', 'Pending', 'Received', 'Cancelled'), po.po_id DESC"
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      console.error("Purchase orders failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:poId/items", async function (request, response) {
    try {
      // Receiving corrects an order's lines to what arrived. A received order
      // is read back as it was ordered (the copy sp_receive_purchase_order
      // kept), each line carrying what arrived beside it in received_quantity.
      // The unit cost is the one it was received at; a line where nothing
      // arrived has none left, so its cost is null. An order received before
      // the copy was kept falls through to the lines as received.
      const orderedResult = await db.query(
        "SELECT o.product_id, o.quantity, " +
        "(SELECT i.unit_cost FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id " +
        " ORDER BY i.po_item_id LIMIT 1) AS unit_cost, " +
        "NULL AS original_unit_cost, " +
        "o.quantity * (SELECT i.unit_cost FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id " +
        " ORDER BY i.po_item_id LIMIT 1) AS line_cost, " +
        "COALESCE((SELECT SUM(i.quantity) FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id), 0) " +
        " AS received_quantity, " +
        "o.pack_name, o.pack_size, o.pack_count, " +
        "p.product_name, u.unit_name, c.category_name, b.brand_name, " +
        "COALESCE(inv.quantity_in_stock, 0) AS quantity_in_stock " +
        "FROM purchase_order_ordered_items o " +
        "JOIN purchase_orders po ON po.po_id = o.po_id AND po.status = 'Received' " +
        "JOIN products p ON p.product_id = o.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "LEFT JOIN categories c ON c.category_id = p.category_id " +
        "LEFT JOIN brands b ON b.brand_id = p.brand_id " +
        "LEFT JOIN inventory inv ON inv.product_id = o.product_id " +
        "WHERE o.po_id = ? " +
        "ORDER BY o.ordered_item_id",
        [request.params.poId]
      );
      if (orderedResult[0].length > 0) return response.json(orderedResult[0]);

      const rowsResult = await db.query(
        "SELECT i.product_id, i.quantity, i.unit_cost, i.original_unit_cost, i.line_cost, " +
        "i.pack_name, i.pack_size, i.pack_count, " +
        "p.product_name, u.unit_name, c.category_name, b.brand_name, " +
        "COALESCE(inv.quantity_in_stock, 0) AS quantity_in_stock " +
        "FROM purchase_order_items i " +
        "JOIN products p ON p.product_id = i.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "LEFT JOIN categories c ON c.category_id = p.category_id " +
        "LEFT JOIN brands b ON b.brand_id = p.brand_id " +
        "LEFT JOIN inventory inv ON inv.product_id = i.product_id " +
        "WHERE i.po_id = ? " +
        "ORDER BY i.po_item_id",
        [request.params.poId]
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      console.error("PO items failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // The delivery Report on one received order: every material that came in
  // under or over what was ordered, by how much, who counted it in and when,
  // and the clerk's remarks. Worked out from the lines as they were ordered
  // (purchase_order_ordered_items) against the lines as received
  // (purchase_order_items). Read by the manager's order card as well as the
  // clerk's. lines is empty when the delivery matched the order, or when the
  // order was received before the ordered lines were kept.
  app.get("/api/purchase-orders/:poId/reports", async function (request, response) {
    const poId = Number(request.params.poId);
    try {
      const ordersResult = await db.query(
        "SELECT po.po_id, po.status, po.received_at, po.delivery_remarks, " +
        "(SELECT st.full_name FROM audit_logs a JOIN staff st ON st.staff_id = a.staff_id " +
        " WHERE a.action = 'PO_RECEIVED' AND a.details LIKE CONCAT('PO #', po.po_id, ' received%') " +
        " ORDER BY a.log_id DESC LIMIT 1) AS reported_by " +
        "FROM purchase_orders po WHERE po.po_id = ?",
        [poId]
      );
      const order = ordersResult[0][0];
      if (!order) return response.status(404).json({ error: "That purchase order does not exist" });

      const report = {
        reported_by: order.reported_by || null,
        reported_at: order.received_at || null,
        remarks: order.delivery_remarks || null,
        lines: []
      };
      if (order.status !== "Received") return response.json(report);

      const orderedResult = await db.query(
        "SELECT o.product_id, SUM(o.quantity) AS quantity, p.product_name, u.unit_name " +
        "FROM purchase_order_ordered_items o " +
        "JOIN products p ON p.product_id = o.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE o.po_id = ? GROUP BY o.product_id, p.product_name, u.unit_name " +
        "ORDER BY MIN(o.ordered_item_id)",
        [poId]
      );
      const ordered = orderedResult[0];
      // an order received before the ordered lines were kept has nothing to compare
      if (ordered.length === 0) return response.json(report);

      const receivedResult = await db.query(
        "SELECT i.product_id, SUM(i.quantity) AS quantity, p.product_name, u.unit_name " +
        "FROM purchase_order_items i " +
        "JOIN products p ON p.product_id = i.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE i.po_id = ? GROUP BY i.product_id, p.product_name, u.unit_name " +
        "ORDER BY MIN(i.po_item_id)",
        [poId]
      );
      const received = receivedResult[0];

      const arrived = {};
      for (let i = 0; i < received.length; i++) {
        arrived[received[i].product_id] = Number(received[i].quantity) || 0;
      }
      const wasOrdered = {};

      // the ordered lines, in their order, then anything that came without being ordered
      for (let i = 0; i < ordered.length; i++) {
        const line = ordered[i];
        wasOrdered[line.product_id] = true;
        const difference = (arrived[line.product_id] || 0) - (Number(line.quantity) || 0);
        if (difference === 0) continue;
        report.lines.push({
          product_name: line.product_name,
          unit_name: line.unit_name,
          quantity: Math.abs(difference),
          reason: difference < 0 ? "Under-delivery" : "Over-delivery"
        });
      }
      for (let i = 0; i < received.length; i++) {
        const line = received[i];
        if (wasOrdered[line.product_id] || !(Number(line.quantity) > 0)) continue;
        report.lines.push({
          product_name: line.product_name,
          unit_name: line.unit_name,
          quantity: Number(line.quantity),
          reason: "Over-delivery"
        });
      }

      response.json(report);
    } catch (error) {
      console.error("PO report failed:", error.message);
      response.status(500).json({ error: "Unable to read the report on this order" });
    }
  });

  // The clerk's Reference card: a received order, each line with what was
  // ordered beside what arrived. Receiving corrects the order's own lines to
  // what arrived; the lines as they were ordered are the copy
  // sp_receive_purchase_order kept in purchase_order_ordered_items. An order
  // received before that copy was kept has none: "kept" is then false and
  // every line's ordered figure is null.
  app.get("/api/purchase-orders/:poId/reference", async function (request, response) {
    const poId = Number(request.params.poId);
    try {
      const ordersResult = await db.query(
        "SELECT po.po_id, po.status, po.order_date, po.confirmed_at, po.received_at, s.supplier_name, " +
        "rb.full_name AS raised_by, cb.full_name AS confirmed_by, " +
        "(SELECT st.full_name FROM audit_logs a JOIN staff st ON st.staff_id = a.staff_id " +
        " WHERE a.action = 'PO_RECEIVED' AND a.details LIKE CONCAT('PO #', po.po_id, ' received%') " +
        " ORDER BY a.log_id DESC LIMIT 1) AS received_by " +
        "FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id " +
        "LEFT JOIN staff rb ON rb.staff_id = po.raised_by_staff_id " +
        "LEFT JOIN staff cb ON cb.staff_id = po.confirmed_by_staff_id " +
        "WHERE po.po_id = ?",
        [poId]
      );
      const orders = ordersResult[0];
      if (orders.length === 0) return response.status(404).json({ error: "That purchase order does not exist" });
      const order = orders[0];
      if (order.status !== "Received") {
        return response.status(400).json({ error: "Purchase order #" + poId + " has not been received yet." });
      }

      // what was ordered (the copy) and what arrived (the corrected lines)
      const orderedResult = await db.query(
        "SELECT o.product_id, o.quantity, o.pack_name, o.pack_size, o.pack_count, " +
        "p.product_name, u.unit_name " +
        "FROM purchase_order_ordered_items o " +
        "JOIN products p ON p.product_id = o.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE o.po_id = ? ORDER BY o.ordered_item_id",
        [poId]
      );
      const ordered = orderedResult[0];
      const receivedResult = await db.query(
        "SELECT i.product_id, i.quantity, i.pack_name, i.pack_size, i.pack_count, " +
        "p.product_name, u.unit_name " +
        "FROM purchase_order_items i " +
        "JOIN products p ON p.product_id = i.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE i.po_id = ? ORDER BY i.po_item_id",
        [poId]
      );
      const received = receivedResult[0];

      // one line per material: the ordered lines first, in their order, then
      // anything that arrived without being ordered
      const lines = [];
      for (let i = 0; i < ordered.length; i++) {
        lines.push({
          product_id: ordered[i].product_id,
          product_name: ordered[i].product_name,
          unit_name: ordered[i].unit_name,
          ordered: ordered[i],
          received: null
        });
      }
      for (let i = 0; i < received.length; i++) {
        let line = null;
        for (let j = 0; j < lines.length; j++) {
          if (lines[j].product_id === received[i].product_id) line = lines[j];
        }
        if (line === null) {
          line = {
            product_id: received[i].product_id,
            product_name: received[i].product_name,
            unit_name: received[i].unit_name,
            ordered: null,
            received: null
          };
          lines.push(line);
        }
        line.received = received[i];
      }

      response.json({ order: order, kept: ordered.length > 0, lines: lines });
    } catch (error) {
      console.error("PO reference failed:", error.message);
      response.status(500).json({ error: "Unable to open the purchase order" });
    }
  });

  // The order as a document: the order, its lines and the shop, the way the
  // printed sheet, the PDF and the supplier's page all read it. Null when
  // there is no such order.
  async function readOrderDocument(poId) {
    const ordersResult = await db.query(
      "SELECT po.po_id, po.status, po.order_date, po.confirmed_at, " +
      "po.supplier_code, po.supplier_sent_at, " +
      "po.supplier_response, po.supplier_responded_at, po.supplier_note, po.supplier_ship_date, " +
      "po.discount, " +
      "s.supplier_id, s.supplier_name, s.contact_person, s.contact_number, " +
      "s.email AS supplier_email, s.address AS supplier_address, " +
      "COALESCE(rb.full_name, st.full_name) AS raised_by, " +
      "cb.full_name AS confirmed_by " +
      "FROM purchase_orders po " +
      "JOIN suppliers s ON s.supplier_id = po.supplier_id " +
      "LEFT JOIN staff rb ON rb.staff_id = po.raised_by_staff_id " +
      "LEFT JOIN staff cb ON cb.staff_id = po.confirmed_by_staff_id " +
      "LEFT JOIN audit_logs a ON a.action = 'PURCHASE_ORDER' " +
      "AND a.details LIKE CONCAT('PO #', po.po_id, ' %') " +
      "LEFT JOIN staff st ON st.staff_id = a.staff_id " +
      "WHERE po.po_id = ? " +
      "LIMIT 1",
      [poId]
    );
    const orders = ordersResult[0];
    if (orders.length === 0) return null;

    const itemsResult = await db.query(
      "SELECT i.po_item_id, i.product_id, i.quantity, i.unit_cost, i.original_unit_cost, i.line_cost, " +
      "i.pack_name, i.pack_size, i.pack_count, " +
      "p.product_name, u.unit_name, c.category_name, b.brand_name " +
      "FROM purchase_order_items i " +
      "JOIN products p ON p.product_id = i.product_id " +
      "LEFT JOIN units u ON u.unit_id = p.unit_id " +
      "LEFT JOIN categories c ON c.category_id = p.category_id " +
      "LEFT JOIN brands b ON b.brand_id = p.brand_id " +
      "WHERE i.po_id = ? " +
      "ORDER BY i.po_item_id",
      [poId]
    );
    const items = itemsResult[0];

    const settingsResult = await db.query(
      "SELECT store_name, address, tin, registration_type, invoice_note " +
      "FROM store_settings WHERE setting_id = 1"
    );
    const settings = settingsResult[0];

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
      const rowsResult = await db.query("SELECT supplier_code FROM purchase_orders WHERE po_id = ?", [order.po_id]);
      const rows = rowsResult[0];
      code = rows.length > 0 ? rows[0].supplier_code : null;
    }
    const link = supplierOrderLink(request.protocol + "://" + request.get("host"), code);
    if (!link) return null;
    return { link: link, qr: await qrPng(link) };
  }

  // The order as a printable document, assembled in one request. An approved
  // order carries the supplier's link and its QR code (a data URL) for the
  // printed sheet; the code itself is not handed out.
  app.get("/api/purchase-orders/:poId/document", async function (request, response) {
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
  app.post("/api/purchase-orders", async function (request, response) {
    const supplierId = request.body.supplierId;
    const supplierName = request.body.supplierName;
    const contactPerson = request.body.contactPerson;
    const contactNumber = request.body.contactNumber;
    const supplierEmail = request.body.supplierEmail;
    const supplierAddress = request.body.supplierAddress;
    const items = request.body.items;

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
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
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
        const knownResult = await db.query(
          "SELECT supplier_id FROM suppliers WHERE LOWER(supplier_name) = LOWER(?)", [company]);
        const known = knownResult[0];
        if (known.length === 0) {
          return response.status(400).json({
            error: company + " is not on file. Only the manager can add a supplier; " +
                   "ask the manager to add it under Records, then pick it here."
          });
        }
      }

      // a line naming a new material needs a category and a unit already on file
      const newLines = [];
      const newCategories = [];
      const newUnits = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].product_id) {
          newLines.push(lines[i]);
          newCategories.push(lines[i].category_name);
          newUnits.push(lines[i].unit_name);
        }
      }
      const onFile = await namesOnFile(newCategories, newUnits);
      if (onFile.error) return response.status(400).json({ error: onFile.error });
      for (let i = 0; i < newLines.length; i++) {
        const line = newLines[i];
        line.category_name = onFile.category(line.category_name);
        line.unit_name = onFile.unit(line.unit_name);
      }

      const output = await inventoryClerkProcedures.createPurchaseOrder(
        [Number(supplierId) || null,
         company.slice(0, 100),
         String(contactPerson || "").trim().slice(0, 100),
         cleanPhone(contactNumber) || "",
         String(supplierEmail || "").trim().slice(0, 100),
         String(supplierAddress || "").trim(),
         JSON.stringify(lines),
         getActorId(request)]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // A material typed in as new that turns out to be on file already (the
      // same name) is used as it is, so it may sit with no supplier or with
      // another one. Ordering it from this company registers it to this
      // company, as a brand-new material already is.
      const orderSupplier = Number(output.supplier_id_out) || Number(supplierId) || null;
      if (orderSupplier) {
        for (let i = 0; i < newLines.length; i++) {
          if (!newLines[i].new_name) continue;
          await db.query(
            "UPDATE products SET supplier_id = ? " +
            "WHERE LOWER(product_name) = LOWER(?) AND (supplier_id IS NULL OR supplier_id <> ?)",
            [orderSupplier, newLines[i].new_name, orderSupplier]
          );
        }
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
  app.post("/api/purchase-orders/:poId/decide", async function (request, response) {
    const body = request.body || {};
    const approve = body.approve === true;
    let note = "";
    if (typeof body.note === "string") {
      note = body.note.trim().slice(0, 255);
    }
    // a declined order carries the manager's remarks: why it was declined
    if (!approve && note === "") {
      return response.status(400).json({ error: "Write the remarks: why the purchase order is declined." });
    }

    try {
      const poId = Number(request.params.poId);
      const output = await inventoryClerkProcedures.decidePurchaseOrder(
        [poId, approve, note || null, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      if (!approve) {
        return response.json({ message: output.message, status: "Cancelled" });
      }

      await ensureSupplierCode(poId);
      response.json({
        message: "Purchase order #" + poId + " is approved. The clerk prints it and sends it to the supplier.",
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
  app.post("/api/purchase-orders/:poId/send", async function (request, response) {
    const poId = Number(request.params.poId);

    try {
      const document = await readOrderDocument(poId);
      if (!document) return response.status(404).json({ error: "That purchase order does not exist" });

      const order = document.order;
      const number = "PO-" + String(order.po_id).padStart(6, "0");
      if (order.status !== "Pending") {
        return response.status(409).json({
          error: order.status === "For Approval"
            ? number + " is not approved yet. The manager approves it before it goes to the supplier."
            : number + " is " + String(order.status).toLowerCase() + "; there is nothing to send."
        });
      }

      const email = String(order.supplier_email || "").trim();
      let problem = null;
      if (!email) {
        problem = order.supplier_name + " has no email address on file. Print the order and send it to them.";
      } else if (!isMailConfigured()) {
        problem = "Mail is not set up on this server. Print the order and send it to " + order.supplier_name + ".";
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
          console.error("Emailing " + number + " to the supplier failed:", error.message);
          problem = "The mail server refused " + number + " for " + email + ": " + error.message + " " +
                    "Print the order and send it to them.";
        }
      }

      if (problem) {
        await writeAuditLog(request, "PURCHASE_ORDER_NOT_SENT", number + " not emailed to " + order.supplier_name + ": " + problem,
          { po_id: order.po_id, supplier: order.supplier_name, email: email || null, emailed: false });
        return response.status(400).json({ error: problem });
      }

      await db.query("UPDATE purchase_orders SET supplier_sent_at = NOW() WHERE po_id = ?", [poId]);
      await writeAuditLog(request, "PURCHASE_ORDER_SENT", number + " emailed to " + order.supplier_name + " at " + email,
        { po_id: order.po_id, supplier: order.supplier_name, email: email, emailed: true });

      response.json({
        message: number + " was emailed to " + order.supplier_name + " at " + email + ", with the PDF and the link " +
                 "to accept or decline it.",
        linked: Boolean(answer)
      });
    } catch (error) {
      console.error("Sending the purchase order failed:", error.message);
      response.status(500).json({ error: "The order could not be sent. Print it and send it to the supplier." });
    }
  });

  // The clerk printed an approved order and handed it to the supplier: the
  // order is marked as sent, so it reads Pending Supplier Confirmation until
  // the supplier accepts or declines it from the link on the order.
  app.post("/api/purchase-orders/:poId/mark-sent", async function (request, response) {
    const poId = Number(request.params.poId);
    try {
      const rowsResult = await db.query(
        "SELECT po.po_id, po.status, po.supplier_response, po.supplier_sent_at, s.supplier_name " +
        "FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ?", [poId]);
      const order = rowsResult[0][0];
      if (!order) return response.status(404).json({ error: "That purchase order does not exist" });

      const number = "PO-" + String(order.po_id).padStart(6, "0");
      if (order.status !== "Pending") {
        return response.status(409).json({
          error: order.status === "For Approval"
            ? number + " is not approved yet. The manager approves it before it goes to the supplier."
            : number + " is " + String(order.status).toLowerCase() + "; there is nothing to send."
        });
      }
      if (order.supplier_response) {
        return response.status(409).json({
          error: order.supplier_name + " has already " + String(order.supplier_response).toLowerCase() + " " + number + "."
        });
      }

      await db.query("UPDATE purchase_orders SET supplier_sent_at = COALESCE(supplier_sent_at, NOW()) WHERE po_id = ?",
        [poId]);
      await writeAuditLog(request, "PURCHASE_ORDER_SENT", number + " sent to " + order.supplier_name + " (printed copy)",
        { po_id: order.po_id, supplier: order.supplier_name, emailed: false });
      if (publishChange) publishChange("inventory", "sent " + number, request.headers["x-client-id"] || null);

      response.json({
        message: number + " is marked as sent to " + order.supplier_name + ". It waits for the supplier to accept or decline it."
      });
    } catch (error) {
      console.error("Marking the purchase order as sent failed:", error.message);
      response.status(500).json({ error: "Unable to mark the purchase order as sent" });
    }
  });

  // ==========================================
  // THE SUPPLIER'S PAGE (supplier-order.html) -- no account, only the link's code
  // ==========================================
  // The code is 32 random bytes, so it cannot be guessed; the access rules in
  // access-control.js lets these three routes through without a session for that reason.
  // Gives back the order's document for a code, or null for an unknown one.
  async function orderForCode(code) {
    const rowsResult = await db.query(
      "SELECT po_id FROM purchase_orders WHERE supplier_code = ?", [String(code)]);
    const rows = rowsResult[0];
    if (rows.length === 0) return null;
    return readOrderDocument(rows[0].po_id);
  }

  const UNKNOWN_LINK = "This link is not valid. Check it against the printed order, or contact the shop.";

  // what the supplier may see: the order, the lines and the shop, not the
  // shop's notes on it
  function supplierView(document) {
    const order = document.order;

    // the order lines, with only the fields the supplier page needs
    const viewItems = [];
    for (let i = 0; i < document.items.length; i++) {
      const item = document.items[i];
      viewItems.push({
        id: item.po_item_id,
        product_name: item.product_name, brand_name: item.brand_name, category_name: item.category_name,
        quantity: item.quantity, unit_name: item.unit_name, unit_cost: item.unit_cost, line_cost: item.line_cost,
        original_unit_cost: item.original_unit_cost,
        pack_name: item.pack_name, pack_size: item.pack_size, pack_count: item.pack_count
      });
    }

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
      items: viewItems,
      shop: { store_name: document.shop.store_name, address: document.shop.address }
    };
  }

  app.get("/api/supplier-order/:code", async function (request, response) {
    try {
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });
      response.json(supplierView(document));
    } catch (error) {
      console.error("Supplier order failed:", error.message);
      response.status(500).json({ error: "The order could not be opened. Try again in a moment." });
    }
  });

  app.get("/api/supplier-order/:code/pdf", async function (request, response) {
    try {
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });

      const number = "PO-" + String(document.order.po_id).padStart(6, "0");
      const answer = await supplierAnswerLink(request, document.order);
      const pdf = await purchaseOrderPdf(Object.assign({}, document,
        answer ? { link: answer.link, qr: answer.qr } : {}));
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Disposition", "inline; filename=\"" + number + ".pdf\"");
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

  app.post("/api/supplier-order/:code/respond", async function (request, response) {
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
      // the date must be written like 2026-10-14, and be a day that really exists
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
      for (let i = 0; i < asked.length; i++) {
        const entry = asked[i];
        let item = null;
        for (let n = 0; n < document.items.length; n++) {
          if (Number(document.items[n].po_item_id) === Number(entry && entry.id)) {
            item = document.items[n];
            break;
          }
        }
        if (!item) {
          return response.status(400).json({
            error: "A price was sent for a line that is not on this order. Reload the page and try again." });
        }
        const price = Math.round(Number(entry.unitCost) * 100) / 100;
        if (!Number.isFinite(price) || price <= 0 || price >= PRICE_CEILING) {
          return response.status(400).json({ error: "Enter a price above zero for " + item.product_name + "." });
        }
        let alreadyChanged = false;
        for (let n = 0; n < changes.length; n++) {
          if (changes[n].item === item) alreadyChanged = true;
        }
        if (price !== Number(item.unit_cost) && !alreadyChanged) {
          changes.push({ item: item, price: price });
        }
      }

      let before = 0;
      for (let i = 0; i < document.items.length; i++) {
        const item = document.items[i];
        before += Number(item.line_cost || 0);
      }
      let after = before;
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
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
      const queryResult = await connection.query(
        "UPDATE purchase_orders " +
        "SET supplier_response = ?, supplier_responded_at = NOW(), supplier_note = ?, supplier_ship_date = ?, " +
        "discount = CASE WHEN ? THEN ? ELSE discount END " +
        "WHERE po_id = ? AND status = 'Pending' AND supplier_response IS NULL",
        [accept ? "Accepted" : "Declined", note || null, shipDate, accept, discount, order.po_id]);
      const result = queryResult[0];

      if (result.affectedRows === 0) {
        await connection.rollback();
        connection.release();
        connection = null;
        const again = await readOrderDocument(order.po_id);
        let why = number + " can no longer be answered here: it is " + String(again.order.status).toLowerCase() + ".";
        if (again.order.supplier_response) {
          why = number + " was already " + again.order.supplier_response.toLowerCase() + ". Contact the shop to change it.";
        }
        return response.status(409).json({ error: why, view: supplierView(again) });
      }

      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        await connection.query(
          "UPDATE purchase_order_items " +
          "SET original_unit_cost = COALESCE(original_unit_cost, unit_cost), unit_cost = ? " +
          "WHERE po_item_id = ? AND po_id = ?",
          [change.price, change.item.po_item_id, order.po_id]);
      }

      await connection.commit();
      connection.release();
      connection = null;

      // the manager and the clerk are told at once, on the bell
      let title = order.supplier_name + " accepted purchase order #" + order.po_id;
      let message = order.supplier_name + " accepted " + number + " and will ship it on " + dayText(shipDate) + ".";
      if (changes.length > 0) {
        title = order.supplier_name + " accepted purchase order #" + order.po_id + " with new prices";
        const priceChanges = [];
        for (let i = 0; i < changes.length; i++) {
          const change = changes[i];
          priceChanges.push(change.item.product_name + " " + pesoText(change.item.unit_cost) + " to " + pesoText(change.price));
        }
        message += " They changed the price on " + changes.length + " " + (changes.length === 1 ? "line" : "lines") + ": " +
                   priceChanges.join("; ") +
                   ". Order total " + pesoText(before) + " to " + pesoText(after) + ".";
      }
      if (discount > 0) {
        message += " They gave a discount of " + pesoText(discount) + ", so the order comes to " + pesoText(after - discount) + ".";
      }
      if (note) message += " Their note: " + note;
      if (!accept) {
        title = order.supplier_name + " cannot fill purchase order #" + order.po_id;
        message = order.supplier_name + " declined " + number + ": " + note + " Order the materials elsewhere, " +
                  "or contact the supplier.";
      }
      await db.query(
        "INSERT INTO notifications (target_role_id, notif_type, title, message) " +
        "SELECT role_id, 'Purchase Order', ?, ? FROM roles WHERE role_name IN ('Manager', 'Inventory Clerk')",
        [title.slice(0, 150), message]);

      let details = number + " declined by " + order.supplier_name + " from the link on the order: " + note;
      if (accept) {
        details = number + " accepted by " + order.supplier_name + " from the link on the order, shipping " + shipDate +
          (changes.length > 0
            ? ", " + changes.length + " price(s) changed, total " + pesoText(before) + " to " + pesoText(after)
            : "") +
          (discount > 0 ? ", discount " + pesoText(discount) : "") +
          (note ? ": " + note : "");
      }
      const auditPrices = [];
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        auditPrices.push({ product: change.item.product_name, from: Number(change.item.unit_cost), to: change.price });
      }
      await writeAuditLog(request, accept ? "PURCHASE_ORDER_ACCEPTED" : "PURCHASE_ORDER_DECLINED_BY_SUPPLIER",
        details,
        { po_id: order.po_id, supplier: order.supplier_name, accepted: accept, ship_date: shipDate, discount: discount,
          prices: auditPrices });

      // the bell and the order list update without a reload
      if (publishChange) {
        publishChange("notifications", "supplier answered " + number, null);
        publishChange("inventory", "supplier answered " + number, null);
      }

      response.json({
        message: accept
          ? "Thank you. " + number + " is accepted, and " + (document.shop.store_name || "the shop") + " has been told."
          : "Thank you. " + (document.shop.store_name || "The shop") + " has been told that " + number + " cannot be filled.",
        view: supplierView(await readOrderDocument(order.po_id))
      });
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (ignored) {
          // nothing more can be done if the rollback itself fails
        }
        connection.release();
      }
      console.error("Supplier response failed:", error.message);
      response.status(500).json({ error: "Your answer could not be saved. Try again in a moment." });
    }
  });

  // Receiving, by the clerk once the manager has confirmed the order: the
  // body carries the count sheet, including anything never ordered. An empty
  // body receives the order exactly as written.
  app.post("/api/purchase-orders/:poId/receive", async function (request, response) {
    let received;
    if (Array.isArray(request.body && request.body.received)) {
      received = request.body.received;
    } else {
      received = [];
    }

    // what was actually counted in, line by line
    const sheet = [];
    for (let i = 0; i < received.length; i++) {
      const line = received[i];
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
      // an order is referred (received) only once the supplier has accepted it
      const stateResult = await db.query(
        "SELECT status, supplier_response FROM purchase_orders WHERE po_id = ?", [Number(request.params.poId)]);
      const state = stateResult[0][0];
      if (!state) return response.status(404).json({ error: "That purchase order does not exist" });
      if (state.status === "Pending" && state.supplier_response !== "Accepted") {
        return response.status(409).json({
          error: "Purchase order #" + request.params.poId + " can only be referred once the supplier has accepted it."
        });
      }

      const output = await inventoryClerkProcedures.receivePurchaseOrder(
        [request.params.poId, JSON.stringify(sheet), discount, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // the clerk's remarks on the delivery, for the order's Report
      const remarks = shortText(body.remarks, 255);
      if (remarks) {
        await db.query("UPDATE purchase_orders SET delivery_remarks = ? WHERE po_id = ?",
          [remarks, Number(request.params.poId)]);
      }

      response.json({ message: output.message, lines: output.lines, extras: output.extras });
    } catch (error) {
      console.error("Receive PO failed:", error.message);
      response.status(500).json({ error: "Unable to receive the purchase order" });
    }
  });

  // RETURNS, DAMAGE AND REFUND REPORTS
  app.get("/api/returns", async function (request, response) {
    try {
      // goods missing from a supplier delivery are the stockroom business;
      // the counter list (the cashier) does not carry them
      let hideMissing = "";
      if (request.actor && request.actor.roleName === CASHIER) {
        hideMissing = "WHERE r.report_type <> 'Missing'";
      }

      const rowsResult = await db.query(
        "SELECT r.return_id, r.report_type, r.quantity, r.reason, r.refund_amount, " +
        "r.restocked, r.disposition, r.status, r.return_date, r.sale_id, r.po_id, " +
        "r.inspected_at, r.inspection_note, " +
        "(r.status = 'Open' AND r.disposition IS NULL AND r.report_type <> 'Missing') AS awaiting_inspection, " +
        "p.product_id, p.product_name, u.unit_name, " +
        "COALESCE(s.full_name, 'Unknown') AS reported_by, " +
        "i.full_name AS inspected_by " +
        "FROM returned_items r " +
        "JOIN products p ON p.product_id = r.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "LEFT JOIN staff s ON s.staff_id = r.reported_by_staff_id " +
        "LEFT JOIN staff i ON i.staff_id = r.inspected_by_staff_id " +
        hideMissing +
        " ORDER BY FIELD(r.status, 'Open', 'Resolved'), r.disposition IS NOT NULL, r.return_id DESC"
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      console.error("Returns failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // Filing a return: a reason is compulsory. So is a disposition,
  // except on a refund from the counter, which the clerk inspects before it
  // is decided: a cashier never says where the goods go, whatever is sent.
  // A driver's refund at the customer's door is treated the same way.
  // restock is still accepted from older callers and mapped across.
  const RETURN_DISPOSITIONS = ["Return to Stock", "Write-Off"];
  const LONGEST_RETURN_REASON = 255;

  // A driver's figures may be off by rounding: a quantity is kept to three
  // decimals and an amount to cents, so these small margins are let through.
  const QUANTITY_SLACK = 0.0005;
  const AMOUNT_SLACK = 0.01;

  // A refund on a sale is checked against the sale: the item is on it, that
  // many are left to refund, and no more than was charged for them. Gives back
  // the sentence to show when something is wrong, or "" when it is fine.
  // These checks give a friendly message; sp_file_return_report checks the
  // same again under a lock, and that is the one that cannot be raced.
  async function refundProblem(saleId, productId, quantity, refundAmount) {
    // what the sale holds of this product, and what has already come back
    const linesResult = await db.query(
      "SELECT COALESCE(SUM(quantity), 0) AS sold, COALESCE(SUM(subtotal), 0) AS worth " +
      "FROM sale_items WHERE sale_id = ? AND product_id = ?",
      [saleId, productId]
    );
    const lines = linesResult[0];
    const takenResult = await db.query(
      "SELECT COALESCE(SUM(quantity), 0) AS refunded FROM returned_items " +
      "WHERE sale_id = ? AND product_id = ? AND report_type IN ('Refunded', 'Return')",
      [saleId, productId]
    );
    const taken = takenResult[0];
    // the lines add up to total_amount; the customer paid final_amount, after the discount
    const salesResult = await db.query(
      "SELECT total_amount, final_amount FROM sales WHERE sale_id = ?", [saleId]);
    const sales = salesResult[0];
    if (sales.length === 0) {
      return "That sale was not found.";
    }
    let afterDiscount = 1;
    if (Number(sales[0].total_amount) > 0) {
      afterDiscount = Number(sales[0].final_amount) / Number(sales[0].total_amount);
    }

    const qty = Number(quantity);
    if (!(qty > 0)) {
      return "Quantity must be greater than zero.";
    }

    const sold = Number(lines[0].sold);
    const left = sold - Number(taken[0].refunded);
    if (sold === 0) {
      return "That item is not on this sale.";
    }
    if (qty > left + QUANTITY_SLACK) {
      return left <= 0 ? "That item has already been refunded in full."
                       : "Only " + left + " of that item can still be refunded.";
    }

    // never more than the customer was charged for those pieces (after the discount)
    const mostToRefund = Number(lines[0].worth) * afterDiscount * qty / sold;
    if (!(Number(refundAmount) > 0) || Number(refundAmount) > mostToRefund + AMOUNT_SLACK) {
      return "The refund must be more than zero and no more than " + mostToRefund.toFixed(2) + ", " +
             "what the customer was charged for those pieces.";
    }
    return "";
  }

  app.post("/api/returns", async function (request, response) {
    const productId = request.body.productId;
    const saleId = request.body.saleId;
    const reportType = request.body.reportType;
    const quantity = request.body.quantity;
    const reason = request.body.reason;
    const refundAmount = request.body.refundAmount;
    const disposition = request.body.disposition;
    const restock = request.body.restock;

    if (!productId || !reportType || !quantity) {
      return response.status(400).json({ error: "Product, type and quantity are all required" });
    }

    // goods missing from a delivery are filed by the clerk, from Make a Report
    if (reportType === "Missing") {
      return response.status(400).json({ error: "Goods missing from a delivery are filed from the Make a Report screen." });
    }

    let explanation = "";
    if (typeof reason === "string") {
      explanation = reason.trim();
    }
    if (explanation === "") {
      return response.status(400).json({ error: "A reason is required." });
    }
    if (explanation.length > LONGEST_RETURN_REASON) {
      return response.status(400).json({ error: "The reason is at most " + LONGEST_RETURN_REASON + " characters." });
    }

    // A refund amount, when one is sent, is a real number of zero or more. A
    // negative one would add money back onto the customer's bill. The
    // procedure checks the same again.
    if (refundAmount !== undefined && refundAmount !== null && refundAmount !== "") {
      const amountSent = Number(refundAmount);
      if (!Number.isFinite(amountSent) || amountSent < 0) {
        return response.status(400).json({ error: "The refund amount must be a number, zero or more." });
      }
    }

    // A refund is money going back against a sale, so it has to name the sale.
    if (reportType === "Refunded" && !saleId) {
      return response.status(400).json({ error: "A refund must be filed against a sale." });
    }

    const isDriver = request.actor && request.actor.roleName === DRIVER;

    // A driver refunds at the customer's door, and only on a delivery they
    // took. Nothing a driver sends is trusted: the sale, the item, how many
    // and how much are all checked against the sale itself.
    if (isDriver) {
      if (reportType !== "Refunded" || !saleId) {
        return response.status(400).json({ error: "A driver can only refund an item on a sale they are delivering." });
      }

      try {
        const deliveriesResult = await db.query(
          "SELECT d.status " +
          "FROM deliveries d " +
          "WHERE d.sale_id = ? AND d.delivery_staff_id = ? AND d.is_archived = FALSE",
          [saleId, request.actor.staffId]
        );
        const deliveries = deliveriesResult[0];
        if (deliveries.length === 0) {
          return response.status(403).json({ error: "You can only refund items on a delivery you took." });
        }
        // the goods have to have reached the customer
        if (!["Out for Delivery", "Delivered"].includes(deliveries[0].status)) {
          return response.status(409).json({ error: "Refund items once the delivery is out with the customer." });
        }
      } catch (error) {
        console.error("Driver refund check failed:", error.message);
        return response.status(500).json({ error: "Unable to check the refund" });
      }
    }

    // A refund on a sale comes off what the customer owes, so whoever files it
    // (driver or cashier) has it checked against the sale: the item is on it,
    // that many are left to refund, and no more than was charged for them.
    // These checks give a friendly message; sp_file_return_report checks the
    // same again under a lock, and that is the one that cannot be raced.
    // (A refund with no sale named is refused above.)
    if (reportType === "Refunded" && saleId) {
      try {
        const problem = await refundProblem(saleId, productId, quantity, refundAmount);
        if (problem !== "") {
          return response.status(400).json({ error: problem });
        }
      } catch (error) {
        console.error("Refund check failed:", error.message);
        return response.status(500).json({ error: "Unable to check the refund" });
      }
    }

    // a refund brought back at the counter or from the door waits for the clerk
    const fromCounter = request.actor &&
      (request.actor.roleName === CASHIER || request.actor.roleName === DRIVER);
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
      const output = await inventoryClerkProcedures.fileReturnReport(
        [productId, saleId || null, reportType, quantity, explanation,
         refundAmount || 0, where, getActorId(request)]
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
        reportType + " #" + output.report_id + ": " + quantity + " unit(s), " + (where || "awaiting inspection"),
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

      // offBalance: how much of the refund came off what the customer owes
      response.json({ message: output.message, reportId: output.report_id, disposition: where,
                      awaitingInspection: where === null, offBalance: Number(output.off_balance) || 0 });
    } catch (error) {
      console.error("File report failed:", error.message);
      response.status(500).json({ error: "Unable to file the report" });
    }
  });

  // Make a Report: one report for several items at once. The body has the
  // type, the reason, the sale (a refund) or the purchase order (goods missing
  // from a delivery), and the list of items, each with its own quantity (and
  // refund). The procedure files them all in one transaction: if one item is
  // refused, nothing is filed. Only the clerk can reach this route.
  const REPORT_TYPES = ["Return", "Damaged", "Refunded", "Missing"];
  const MOST_REPORT_ITEMS = 50;

  app.post("/api/returns/batch", async function (request, response) {
    const body = request.body || {};
    const reportType = body.reportType;

    if (!REPORT_TYPES.includes(reportType)) {
      return response.status(400).json({ error: "Pick the type of report." });
    }

    let explanation = "";
    if (typeof body.reason === "string") {
      explanation = body.reason.trim();
    }
    if (explanation === "") {
      return response.status(400).json({ error: "A reason is required." });
    }
    if (explanation.length > LONGEST_RETURN_REASON) {
      return response.status(400).json({ error: "The reason is at most " + LONGEST_RETURN_REASON + " characters." });
    }

    // the items: each material once, with a quantity above zero
    const sent = Array.isArray(body.items) ? body.items : [];
    if (sent.length === 0) {
      return response.status(400).json({ error: "Add at least one item to the report." });
    }
    if (sent.length > MOST_REPORT_ITEMS) {
      return response.status(400).json({ error: "A report can hold at most " + MOST_REPORT_ITEMS + " items." });
    }

    const items = [];
    const seen = [];
    for (let i = 0; i < sent.length; i++) {
      const line = sent[i];
      const productId = Number(line.productId);
      const quantity = Math.round(Number(line.quantity) * 1000) / 1000;
      let refund = 0;
      if (line.refundAmount !== undefined && line.refundAmount !== null && line.refundAmount !== "") {
        refund = Number(line.refundAmount);
      }

      if (!Number.isInteger(productId) || productId <= 0) {
        return response.status(400).json({ error: "An item in the report has no material." });
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return response.status(400).json({ error: "Every item needs a quantity greater than zero." });
      }
      if (!Number.isFinite(refund) || refund < 0) {
        return response.status(400).json({ error: "The refund amount must be a number, zero or more." });
      }
      // a refund amount goes only with a refund or a plain return
      if (reportType !== "Refunded" && reportType !== "Return") {
        refund = 0;
      }
      if (seen.includes(productId)) {
        return response.status(400).json({ error: "A material can be listed only once in a report." });
      }
      seen.push(productId);
      items.push({ product_id: productId, quantity: quantity, refund_amount: refund });
    }
    // always filed in the same order, so two reports at once lock the shelf rows
    // in the same order and cannot wait on each other
    items.sort(function (a, b) { return a.product_id - b.product_id; });

    // goods missing from a delivery name their purchase order; a refund names
    // its sale; the others may name a sale or leave it out
    let poId = null;
    let saleId = null;
    if (reportType === "Missing") {
      poId = Number(body.poId);
      if (!Number.isInteger(poId) || poId <= 0) {
        return response.status(400).json({ error: "Pick the purchase order the goods were missing from." });
      }
    } else if (body.saleId) {
      saleId = Number(body.saleId);
      if (!Number.isInteger(saleId) || saleId <= 0) {
        return response.status(400).json({ error: "The sale number must be a whole number." });
      }
    }
    if (reportType === "Refunded" && !saleId) {
      return response.status(400).json({ error: "A refund must be filed against a sale." });
    }

    // where the goods go. "Put back on the shelf: no" means they cannot be
    // sold, so they are written off. A refund the clerk does not decide waits
    // for inspection (no word). Missing goods have nowhere to go.
    let where = null;
    if (reportType !== "Missing") {
      if (RETURN_DISPOSITIONS.includes(body.disposition)) {
        where = body.disposition;
      } else if (body.restock === true) {
        where = "Return to Stock";
      } else if (reportType !== "Refunded") {
        where = "Write-Off";
      }
    }

    try {
      // a refund is checked against its sale, item by item, for a friendly message
      if (reportType === "Refunded") {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const problem = await refundProblem(saleId, item.product_id, item.quantity, item.refund_amount);
          if (problem !== "") {
            const namesResult = await db.query("SELECT product_name FROM products WHERE product_id = ?", [item.product_id]);
            const names = namesResult[0];
            const label = names.length > 0 ? names[0].product_name + ": " : "";
            return response.status(400).json({ error: label + problem + " Nothing was filed." });
          }
        }
      }

      const output = await inventoryClerkProcedures.fileReturnReports(
        [JSON.stringify(items), saleId, reportType, explanation, where, poId, getActorId(request)]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      const reportIdTexts = String(output.report_ids).split(",");
      const reportIds = [];
      for (let i = 0; i < reportIdTexts.length; i++) {
        reportIds.push(Number(reportIdTexts[i]));
      }
      await writeAuditLog(
        request,
        reportType === "Refunded" ? "REFUND" : "RETURN",
        reportType + " report for " + items.length + " item(s): #" + reportIds.join(", #") +
          (poId ? ", purchase order #" + poId : ""),
        {
          report_ids: reportIds,
          report_type: reportType,
          po_id: poId,
          sale_id: saleId,
          disposition: where,
          items: items,
          reason: explanation
        }
      );

      response.json({ message: output.message, reportIds: reportIds, filed: reportIds.length,
                      disposition: where, offBalance: Number(output.off_balance) || 0 });
    } catch (error) {
      console.error("File report (several items) failed:", error.message);
      response.status(500).json({ error: "Unable to file the report" });
    }
  });

  // The clerk's verdict on a refund from the counter: Return to Stock if it
  // can be sold again, Write-Off if not, with a note. A report that was
  // decided at filing is simply closed.
  app.post("/api/returns/:reportId/resolve", async function (request, response) {
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
      const output = await inventoryClerkProcedures.resolveReturnReport(
        [request.params.reportId, verdict, note || null, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      if (verdict) {
        let details = "Report #" + request.params.reportId + " inspected: " + verdict;
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
  app.get("/api/notifications", async function (request, response) {
    const roleId = request.actor.roleId;

    try {
      const rowsResult = await db.query(
        "SELECT n.notification_id, n.notif_type, n.title, n.message, n.is_read, n.created_at, " +
        "n.product_id, p.product_name, " +
        "COALESCE(s.full_name, 'System') AS from_name, " +
        "COALESCE(r.role_name, 'Automatic') AS from_role " +
        "FROM notifications n " +
        "LEFT JOIN products p ON p.product_id = n.product_id " +
        "LEFT JOIN staff s ON s.staff_id = n.created_by_staff_id " +
        "LEFT JOIN roles r ON r.role_id = s.role_id " +
        "WHERE n.target_role_id IS NULL OR n.target_role_id = ? " +
        "ORDER BY n.is_read, n.notification_id DESC " +
        "LIMIT 60",
        [roleId]
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      console.error("Notifications failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/notifications/:notificationId/read", async function (request, response) {
    try {
      await db.query(
        "UPDATE notifications SET is_read = TRUE " +
        "WHERE notification_id = ? AND (target_role_id IS NULL OR target_role_id = ?)",
        [request.params.notificationId, request.actor.roleId]
      );
      response.json({ message: "Marked as read" });
    } catch (error) {
      console.error("Mark read failed:", error.message);
      response.status(500).json({ error: "Unable to mark it read" });
    }
  });

  app.post("/api/notifications/read-all", async function (request, response) {
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

module.exports = { registerInventoryRoutes: registerInventoryRoutes };
