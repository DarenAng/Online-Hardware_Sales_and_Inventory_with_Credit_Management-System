const helpers = require("../helpers");
const crypto = require("crypto");
const mailer = require("../services/mailer");
const inventoryClerkProcedures = require("../database/procedures/inventory-clerk-procedures");
const isMailConfigured = mailer.isMailConfigured;
const sendMail = mailer.sendMail;
const purchaseOrderMessage = mailer.purchaseOrderMessage;
const shortageMessage = mailer.shortageMessage;
const cancelledOrderMessage = mailer.cancelledOrderMessage;
const pricesConfirmedMessage = mailer.pricesConfirmedMessage;
const pricesDeniedMessage = mailer.pricesDeniedMessage;
const supplierOrderLink = mailer.supplierOrderLink;
const qrPng = mailer.qrPng;
const purchaseOrderPdf = require("../services/purchase-order-pdf").purchaseOrderPdf;

function firstGiven(a, b) {
  if (a !== null && a !== undefined) {
    return a;
  }
  return b;
}

function shortText(value, max) {
  const text = String(value || "").trim().slice(0, max);
  if (text === "") {
    return null;
  }
  return text;
}

function looseName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function singularName(value) {
  const name = looseName(value);
  if (/[^aeiou]ies$/.test(name)) return name.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(name)) return name.slice(0, -2);
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

  app.get("/api/inventory/summary", async function (request, response) {
    try {
      // Close orders that ran out of answer time so they are not counted as pending
      await closeUnansweredOrders();
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
        "SELECT COALESCE(SUM(CASE WHEN status IN ('Pending', 'Incomplete') THEN 1 ELSE 0 END), 0) AS pending_po, " +
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
        "SELECT p.product_id, p.product_name, p.price, p.last_cost, p.reorder_point, p.status, " +
        "p.pack_name, p.pack_size, p.description, " +
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
      const hideCost = request.actor && request.actor.roleName === CASHIER;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        row.selling_units = sellingUnitsOf(row.selling_units);
        if (hideCost) delete row.last_cost;
      }
      response.json(rows);
    } catch (error) {
      console.error("Inventory products failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

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

      if (cleaned.unit_name !== "" && cleaned.units_per > 0) {
        units.push(cleaned);
      }
    }

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
    if (price === 0) price = null;

    try {
      const productsResult = await db.query(
        "SELECT p.product_id, p.product_name, p.price, u.unit_name " +
        "FROM products p LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE p.product_id = ?", [productId]);
      const products = productsResult[0];
      if (products.length === 0) return response.status(404).json({ error: "That product was not found." });
      const product = products[0];

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
    const typed = [];
    for (let i = 0; i < typedNames.length; i++) {
      const text = String(typedNames[i] || "").trim();
      if (text !== "") typed.push(text);
    }
    const matches = [];
    if (typed.length === 0) return { onFile: function (value) { return value; } };

    const rowsResult = await db.query(sql);
    const rows = rowsResult[0];
    for (let i = 0; i < typed.length; i++) {
      const value = typed[i];
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

  app.post("/api/materials", async function (request, response) {
    const body = request.body || {};
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    const brandName = String(body.brandName || "").trim();
    const categoryName = String(body.categoryName || "").trim();
    const unitName = String(body.unitName || "").trim();
    const supplierId = Number(body.supplierId) || null;
    const description = String(body.description || "").trim().replace(/\s+/g, " ");

    if (name === "") {
      return response.status(400).json({ error: "A product needs a name." });
    }
    if (description.length > 255) {
      return response.status(400).json({ error: "A description is at most 255 characters." });
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

      if (output.status_code === 200) {
        const sameResult = await db.query(
          "SELECT product_name, is_archived FROM products WHERE product_id = ?", [productId]);
        const same = sameResult[0][0];
        const sameName = same ? same.product_name : name;
        let message = "\"" + sameName + "\" is already on the product list. Nothing was added.";
        if (same && same.is_archived) {
          message = "\"" + sameName + "\" is already on file but was put away in the Archive. " +
                    "Restore it from the Archive screen instead of adding it again.";
        }
        return response.json({ message: message, productId: productId, created: false, archived: Boolean(same && same.is_archived) });
      }

      if (reorderPoint !== null) {
        try {
          await db.query("UPDATE products SET reorder_point = ? WHERE product_id = ?", [reorderPoint, productId]);
        } catch (error) {
          console.error("The product was added, but its reorder point was not saved:", error.message);
        }
      }

      if (description !== "") {
        try {
          await db.query("UPDATE products SET description = ? WHERE product_id = ?", [description, productId]);
        } catch (error) {
          console.error("The product was added, but its description was not saved:", error.message);
        }
      }

      try {
        const clerkResult = await db.query("SELECT full_name FROM staff WHERE staff_id = ?", [getActorId(request)]);
        let clerkName = "the inventory clerk";
        if (clerkResult[0].length > 0 && clerkResult[0][0].full_name) clerkName = clerkResult[0][0].full_name;

        await db.query(
          "INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id) " +
          "SELECT role_id, 'New Product', ?, ?, ?, ? FROM roles WHERE role_name = 'Manager'",
          [("New product added: " + name + " by " + clerkName).slice(0, 150),
           name + " was added to the product list and has no price yet. Set its price under Stocks Overview; " +
           "until then the till cannot sell it.",
           productId, getActorId(request)]);
      } catch (error) {
        console.error("The product was added, but telling the manager failed:", error.message);
      }

      publishChange("notifications", "new product " + productId, request.headers["x-client-id"] || null);

      response.json({
        message: name + " was added to the product list with no price. The manager has been told to set it.",
        productId: productId,
        created: true
      });
    } catch (error) {
      console.error("Create material failed:", error.message);
      response.status(500).json({ error: "Unable to add the product" });
    }
  });

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

      let packName = null;
      let packSize = null;
      if (name) {
        packName = name;
        packSize = Math.round(size * 1000) / 1000;
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

  app.put("/api/inventory/products/:productId/description", async function (request, response) {
    const productId = Number(request.params.productId);
    const description = String((request.body || {}).description || "").trim().replace(/\s+/g, " ");

    if (description.length > 255) {
      return response.status(400).json({ error: "A description is at most 255 characters." });
    }

    try {
      const rowsResult = await db.query(
        "SELECT product_name, description FROM products WHERE product_id = ?", [productId]);
      const rows = rowsResult[0];
      if (rows.length === 0) return response.status(404).json({ error: "Product not found" });
      const before = rows[0];

      let saved = null;
      if (description !== "") saved = description;

      await db.query("UPDATE products SET description = ? WHERE product_id = ?", [saved, productId]);

      const message = "The description of " + before.product_name + " was saved.";
      await writeAuditLog(request, "UPDATE_DESCRIPTION", message, {
        product_id: productId,
        changes: fieldChanges({ description: before.description }, { description: saved })
      });

      response.json({ message: message, description: saved });
    } catch (error) {
      console.error("Product description failed:", error.message);
      response.status(500).json({ error: "Unable to save the description" });
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
        "SELECT a.adjustment_id, a.product_id, a.adjustment_type, a.quantity_before, a.quantity_change, " +
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

    if (!Number.isFinite(Number(quantity))) {
      return response.status(400).json({ error: "The quantity must be a number." });
    }
    if (adjustmentType === "Recount") {
      if (Number(quantity) < 0) {
        return response.status(400).json({ error: "A recount cannot be below zero." });
      }
      // The saved reason gets a "Missing N unit: " prefix, so the remarks must leave room for it
      if (String(reason).trim().length > 200) {
        return response.status(400).json({ error: "The remarks can be at most 200 characters." });
      }
    } else if (Number(quantity) <= 0) {
      return response.status(400).json({ error: "Add and Remove need a quantity greater than zero." });
    }

    let unit = "";
    if (typeof unitName === "string") {
      unit = unitName.trim().slice(0, 20);
    }

    try {
      let savedReason = reason;
      let missing = 0;
      let productName = "";

      // A manual count that is lower than the system stock means products are missing
      if (adjustmentType === "Recount") {
        const stockResult = await db.query(
          "SELECT i.quantity_in_stock, p.product_name, u.unit_name " +
          "FROM inventory i JOIN products p ON p.product_id = i.product_id " +
          "LEFT JOIN units u ON u.unit_id = p.unit_id WHERE i.product_id = ?",
          [productId]
        );
        if (stockResult[0].length > 0) {
          const systemStock = Number(stockResult[0][0].quantity_in_stock);
          productName = stockResult[0][0].product_name;
          missing = Math.round((systemStock - Number(quantity)) * 1000) / 1000;
          if (missing > 0) {
            if (String(reason).trim().length < 5) {
              return response.status(400).json({ error: "Some products are missing. Write what is known about them in the remarks (at least 5 characters)." });
            }
            const missingUnit = unit || stockResult[0][0].unit_name || "";
            savedReason = ("Missing " + missing + (missingUnit ? " " + missingUnit : "") + ": " + String(reason).trim()).slice(0, 255);
          }
        }
      }

      const output = await inventoryClerkProcedures.adjustStock(
        [productId, adjustmentType, quantity, unit || null, savedReason, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // Tell the manager about the missing products
      if (missing > 0) {
        try {
          await db.query(
            "INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id) " +
            "SELECT role_id, 'Stock Adjustment', ?, ?, ?, ? FROM roles WHERE role_name = 'Manager'",
            [("Missing stock: " + productName).slice(0, 150), savedReason, productId, getActorId(request)]
          );
          publishChange("notifications", "missing stock " + productId, request.headers["x-client-id"] || null);
        } catch (error) {
          console.error("The count was saved, but telling the manager failed:", error.message);
        }
      }

      response.json({ message: output.message });
    } catch (error) {
      console.error("Stock adjust failed:", error.message);
      response.status(500).json({ error: "Unable to adjust the stock" });
    }
  });

  // The supplier has this many hours, counted from when the order was sent, to accept or decline it
  const SUPPLIER_ANSWER_HOURS = 12;

  // Closes every sent order whose answer time has run out. Returns how many it closed.
  async function closeUnansweredOrders() {
    const expiredResult = await db.query(
      "SELECT po.po_id, s.supplier_name FROM purchase_orders po " +
      "JOIN suppliers s ON s.supplier_id = po.supplier_id " +
      "WHERE po.status = 'Pending' AND po.supplier_response IS NULL AND po.supplier_sent_at IS NOT NULL " +
      "AND po.supplier_sent_at <= NOW() - INTERVAL " + SUPPLIER_ANSWER_HOURS + " HOUR");
    const expired = expiredResult[0];

    let closed = 0;
    for (let i = 0; i < expired.length; i++) {
      // The same conditions again, so an order answered a moment ago is left alone
      const result = await db.query(
        "UPDATE purchase_orders SET status = 'Cancelled', closed_as = 'No Answer', closed_at = NOW() " +
        "WHERE po_id = ? AND status = 'Pending' AND supplier_response IS NULL AND supplier_sent_at IS NOT NULL " +
        "AND supplier_sent_at <= NOW() - INTERVAL " + SUPPLIER_ANSWER_HOURS + " HOUR",
        [expired[i].po_id]);
      if (result[0].affectedRows === 0) continue;

      closed += 1;
      const number = helpers.poNumber(expired[i].po_id);
      await writeAuditLog(null, "PURCHASE_ORDER_NO_ANSWER",
        number + " closed: " + expired[i].supplier_name + " did not answer within " + SUPPLIER_ANSWER_HOURS + " hours",
        { po_id: expired[i].po_id, supplier: expired[i].supplier_name });
    }

    if (closed > 0 && publishChange) {
      publishChange("inventory", "orders closed without an answer", null);
    }
    return closed;
  }

  // "Nov 21, 2026 2:30 PM" for the supplier page
  function supplierTime(value) {
    const when = new Date(value);
    const day = when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return day + " " + time;
  }

  app.get("/api/purchase-orders", async function (request, response) {
    try {
      await closeUnansweredOrders();
      const rowsResult = await db.query(
        "SELECT po.po_id, po.status, po.order_date, " +
        "po.confirmed_at, po.decision_note, po.received_at, " +
        "po.closed_as, po.closed_note, po.closed_at, cl.full_name AS closed_by, " +
        "IF(po.supplier_sent_at IS NULL, NULL, DATE_ADD(po.supplier_sent_at, INTERVAL " + SUPPLIER_ANSWER_HOURS + " HOUR)) " +
        "AS answer_by, " +
        "po.supplier_sent_at, po.supplier_response, po.supplier_responded_at, po.supplier_note, " +
        "po.supplier_ship_date, po.price_review, po.price_review_at, po.price_review_note, " +
        "po.shortage_sent_at, po.shortage_response, po.shortage_responded_at, po.shortage_note, " +
        "rb.full_name AS raised_by, cb.full_name AS confirmed_by, " +
        "s.supplier_id, s.supplier_name, s.contact_person, s.contact_number, " +
        "NULLIF(TRIM(s.email), '') AS supplier_email, " +
        "COUNT(i.po_item_id) AS line_count, " +
        "(SELECT COUNT(*) FROM purchase_order_removed_items rm WHERE rm.po_id = po.po_id) AS removed_count, " +
        "COALESCE(SUM(i.quantity), 0) AS total_units, " +
        "COALESCE(SUM(i.line_cost), 0) AS goods_cost, " +
        "LEAST(po.discount, COALESCE(SUM(i.line_cost), 0)) AS discount, " +
        "GREATEST(COALESCE(SUM(i.line_cost), 0) - po.discount, 0) AS total_cost, " +
        // Units still owed once a delivery has been counted in: ordered minus received, line by line
        "IF(po.status IN ('Received', 'Incomplete'), COALESCE((SELECT SUM(GREATEST(o.quantity - " +
        " COALESCE((SELECT SUM(r.quantity) FROM purchase_order_items r " +
        "  WHERE r.po_id = o.po_id AND r.product_id = o.product_id), 0), 0)) " +
        " FROM purchase_order_ordered_items o WHERE o.po_id = po.po_id), 0), 0) AS balance_units " +
        "FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id " +
        "LEFT JOIN staff rb ON rb.staff_id = po.raised_by_staff_id " +
        "LEFT JOIN staff cb ON cb.staff_id = po.confirmed_by_staff_id " +
        "LEFT JOIN staff cl ON cl.staff_id = po.closed_by_staff_id " +
        "LEFT JOIN purchase_order_items i ON i.po_id = po.po_id " +
        "GROUP BY po.po_id, po.status, po.order_date, po.confirmed_at, po.decision_note, po.received_at, po.discount, " +
        "po.closed_as, po.closed_note, po.closed_at, cl.full_name, " +
        "po.supplier_sent_at, po.supplier_response, po.supplier_responded_at, po.supplier_note, " +
        "po.supplier_ship_date, po.price_review, po.price_review_at, po.price_review_note, " +
        "po.shortage_sent_at, po.shortage_response, po.shortage_responded_at, po.shortage_note, " +
        "rb.full_name, cb.full_name, " +
        "s.supplier_id, s.supplier_name, s.contact_person, s.contact_number, s.email " +
        "ORDER BY FIELD(po.status, 'For Approval', 'Pending', 'Incomplete', 'Received', 'Cancelled'), po.po_id DESC"
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
      const orderedResult = await db.query(
        "SELECT o.product_id, o.quantity, " +
        // The received line's cost first; a line that arrived as 0 has none, so use the cost saved at receiving
        "COALESCE((SELECT i.unit_cost FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id " +
        " ORDER BY i.po_item_id LIMIT 1), o.unit_cost) AS unit_cost, " +
        "NULL AS original_unit_cost, " +
        "o.quantity * COALESCE((SELECT i.unit_cost FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id " +
        " ORDER BY i.po_item_id LIMIT 1), o.unit_cost) AS line_cost, " +
        "COALESCE((SELECT SUM(i.quantity) FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id), 0) " +
        " AS received_quantity, " +
        "o.pack_name, o.pack_size, o.pack_count, p.pack_name AS product_pack_name, p.pack_size AS product_pack_size, " +
        "(SELECT COUNT(*) FROM stock_adjustments sa " +
        " WHERE sa.reason = CONCAT('Received on purchase order #', o.po_id)) AS receipt_count, " +
        "p.product_name, COALESCE(NULLIF(o.line_description, ''), p.description) AS description, " +
        "u.unit_name, c.category_name, b.brand_name, " +
        "COALESCE(inv.quantity_in_stock, 0) AS quantity_in_stock " +
        "FROM purchase_order_ordered_items o " +
        "JOIN purchase_orders po ON po.po_id = o.po_id AND po.status IN ('Received', 'Incomplete') " +
        "JOIN products p ON p.product_id = o.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "LEFT JOIN categories c ON c.category_id = p.category_id " +
        "LEFT JOIN brands b ON b.brand_id = p.brand_id " +
        "LEFT JOIN inventory inv ON inv.product_id = o.product_id " +
        "WHERE o.po_id = ? " +
        "ORDER BY o.ordered_item_id",
        [request.params.poId]
      );
      if (orderedResult[0].length > 0) {
        await addUnitsToItems(orderedResult[0]);
        return response.json(orderedResult[0]);
      }

      const rowsResult = await db.query(
        "SELECT i.po_item_id, i.product_id, i.quantity, i.unit_cost, i.original_unit_cost, i.line_cost, " +
        "i.pack_name, i.pack_size, i.pack_count, p.pack_name AS product_pack_name, p.pack_size AS product_pack_size, " +
        "p.product_name, COALESCE(NULLIF(i.line_description, ''), p.description) AS description, " +
        "(SELECT COUNT(*) FROM stock_adjustments sa " +
        " WHERE sa.reason = CONCAT('Received on purchase order #', i.po_id)) AS receipt_count, " +
        "p.last_cost, u.unit_name, c.category_name, b.brand_name, " +
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
      await addUnitsToItems(rows);
      // The cashier does not see buying prices
      if (request.actor && request.actor.roleName === CASHIER) {
        for (let i = 0; i < rows.length; i++) delete rows[i].last_cost;
      }
      response.json(rows);
    } catch (error) {
      console.error("PO items failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // The lines the supplier removed before accepting the order
  app.get("/api/purchase-orders/:poId/removed-items", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT r.product_id, r.quantity, r.unit_cost, r.pack_name, r.pack_size, r.pack_count, r.removed_at, " +
        "p.pack_name AS product_pack_name, p.pack_size AS product_pack_size, " +
        "p.product_name, u.unit_name " +
        "FROM purchase_order_removed_items r " +
        "JOIN products p ON p.product_id = r.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE r.po_id = ? " +
        "ORDER BY r.removed_item_id",
        [request.params.poId]
      );
      await addUnitsToItems(rowsResult[0]);
      response.json(rowsResult[0]);
    } catch (error) {
      console.error("PO removed items failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

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

      for (let i = 0; i < ordered.length; i++) {
        const line = ordered[i];
        wasOrdered[line.product_id] = true;
        const difference = (arrived[line.product_id] || 0) - (Number(line.quantity) || 0);
        if (difference === 0) continue;
        report.lines.push({
          product_id: line.product_id,
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
          product_id: line.product_id,
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
        return response.status(400).json({ error: "Purchase order " + helpers.poNumber(poId) + " has not been received yet." });
      }

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

  // The units each material has, so a price or a quantity can be typed in any of them:
  // the base unit, its selling units, the delivery pack of the product, then the pack of the line.
  // Each item needs product_id, unit_name, product_pack_name, product_pack_size, pack_name, pack_size.
  // One query gets the selling units of every product in the list.
  async function addUnitsToItems(items) {
    const sellingUnits = {};
    if (items.length > 0) {
      const productIds = [];
      for (let i = 0; i < items.length; i++) productIds.push(items[i].product_id);
      const unitsResult = await db.query(
        "SELECT product_id, unit_name, units_per FROM product_units WHERE product_id IN (?) " +
        "ORDER BY product_id, units_per, unit_name",
        [productIds]
      );
      for (let i = 0; i < unitsResult[0].length; i++) {
        const row = unitsResult[0][i];
        if (!sellingUnits[row.product_id]) sellingUnits[row.product_id] = [];
        sellingUnits[row.product_id].push({ name: row.unit_name, size: Number(row.units_per) });
      }
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const units = [{ name: item.unit_name || "unit", size: 1 }];
      const extras = (sellingUnits[item.product_id] || []).slice();
      extras.push({ name: item.product_pack_name, size: Number(item.product_pack_size) });
      extras.push({ name: item.pack_name, size: Number(item.pack_size) });
      for (let n = 0; n < extras.length; n++) {
        if (!extras[n].name || !(extras[n].size > 0)) continue;
        // The same name (any letter case) and size is listed once
        let listed = false;
        for (let k = 0; k < units.length; k++) {
          if (units[k].name.toLowerCase() === extras[n].name.toLowerCase() && units[k].size === extras[n].size) listed = true;
        }
        if (!listed) units.push(extras[n]);
      }
      item.units = units;
    }
  }

  async function readOrderDocument(poId) {
    const ordersResult = await db.query(
      "SELECT po.po_id, po.status, po.order_date, po.confirmed_at, " +
      "po.supplier_code, po.supplier_sent_at, po.closed_as, po.closed_note, po.closed_at, " +
      "IF(po.supplier_sent_at IS NULL, NULL, DATE_ADD(po.supplier_sent_at, INTERVAL " + SUPPLIER_ANSWER_HOURS + " HOUR)) " +
      "AS answer_by, " +
      "po.supplier_response, po.supplier_responded_at, po.supplier_note, po.supplier_ship_date, " +
      "po.price_review, po.price_review_at, po.price_review_note, " +
      "po.shortage_sent_at, po.shortage_response, po.shortage_responded_at, po.shortage_note, " +
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
      "p.pack_name AS product_pack_name, p.pack_size AS product_pack_size, " +
      "p.product_name, COALESCE(NULLIF(i.line_description, ''), p.description) AS description, " +
      "p.last_cost, u.unit_name, c.category_name, b.brand_name " +
      "FROM purchase_order_items i " +
      "JOIN products p ON p.product_id = i.product_id " +
      "LEFT JOIN units u ON u.unit_id = p.unit_id " +
      "LEFT JOIN categories c ON c.category_id = p.category_id " +
      "LEFT JOIN brands b ON b.brand_id = p.brand_id " +
      "WHERE i.po_id = ? " +
      "ORDER BY i.po_item_id",
      [poId]
    );
    let items = itemsResult[0];

    if (orders[0].status === "Incomplete" || orders[0].status === "Received") {
      const orderedResult = await db.query(
        "SELECT o.ordered_item_id, o.product_id, o.quantity, o.pack_name, o.pack_size, o.pack_count, " +
        "COALESCE((SELECT i.unit_cost FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id " +
        " ORDER BY i.po_item_id LIMIT 1), o.unit_cost, 0) AS unit_cost, " +
        "(SELECT i.original_unit_cost FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id " +
        " ORDER BY i.po_item_id LIMIT 1) AS original_unit_cost, " +
        "p.pack_name AS product_pack_name, p.pack_size AS product_pack_size, " +
        "p.product_name, COALESCE(NULLIF(o.line_description, ''), p.description) AS description, " +
        "u.unit_name, c.category_name, b.brand_name " +
        "FROM purchase_order_ordered_items o " +
        "JOIN products p ON p.product_id = o.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "LEFT JOIN categories c ON c.category_id = p.category_id " +
        "LEFT JOIN brands b ON b.brand_id = p.brand_id " +
        "WHERE o.po_id = ? " +
        "ORDER BY o.ordered_item_id",
        [poId]
      );
      if (orderedResult[0].length > 0) {
        items = [];
        for (let i = 0; i < orderedResult[0].length; i++) {
          const row = orderedResult[0][i];
          row.po_item_id = row.ordered_item_id;
          row.line_cost = Math.round(Number(row.quantity) * Number(row.unit_cost) * 100) / 100;
          items.push(row);
        }
      }
    }

    await addUnitsToItems(items);

    const settingsResult = await db.query(
      "SELECT store_name, address, tin, registration_type, invoice_note " +
      "FROM store_settings WHERE setting_id = 1"
    );
    const settings = settingsResult[0];

    // Lines the supplier removed when accepting
    const removedResult = await db.query(
      "SELECT p.product_name, r.quantity, u.unit_name, r.pack_name, r.pack_size, r.pack_count " +
      "FROM purchase_order_removed_items r " +
      "JOIN products p ON p.product_id = r.product_id " +
      "LEFT JOIN units u ON u.unit_id = p.unit_id " +
      "WHERE r.po_id = ? " +
      "ORDER BY r.removed_item_id",
      [poId]
    );

    const document = { order: orders[0], items: items, removed: removedResult[0], shop: settings[0] || DEFAULT_STORE_SETTINGS };
    if (orders[0].status === "Incomplete") {
      document.shortage = await readShortage(poId);
    }
    return document;
  }

  // What is still owed on an order. Ordered is the fixed list written at the first receipt,
  // received is what purchase_order_items holds from then on, and short is the difference.
  async function readShortage(poId) {
    const rowsResult = await db.query(
      "SELECT o.product_id, o.quantity AS ordered, " +
      "COALESCE((SELECT SUM(i.quantity) FROM purchase_order_items i " +
      " WHERE i.po_id = o.po_id AND i.product_id = o.product_id), 0) AS received, " +
      "COALESCE((SELECT i.unit_cost FROM purchase_order_items i WHERE i.po_id = o.po_id AND i.product_id = o.product_id " +
      " ORDER BY i.po_item_id LIMIT 1), o.unit_cost, 0) AS unit_cost, " +
      "p.product_name, u.unit_name " +
      "FROM purchase_order_ordered_items o " +
      "JOIN products p ON p.product_id = o.product_id " +
      "LEFT JOIN units u ON u.unit_id = p.unit_id " +
      "WHERE o.po_id = ? " +
      "ORDER BY o.ordered_item_id",
      [poId]
    );
    const rows = rowsResult[0];

    const lines = [];
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const short = Number(row.ordered) - Number(row.received);
      if (short <= 0) continue;
      const amount = Math.round(short * Number(row.unit_cost) * 100) / 100;
      total += amount;
      lines.push({
        product_id: row.product_id,
        product_name: row.product_name,
        unit_name: row.unit_name,
        ordered: Number(row.ordered),
        received: Number(row.received),
        short: short,
        unit_cost: Number(row.unit_cost),
        amount: amount
      });
    }
    return { lines: lines, total: Math.round(total * 100) / 100 };
  }

  // After an order is closed short: the discount cannot be more than the goods that arrived,
  // and the lines that never arrived come off the order.
  async function trimClosedOrder(runner, poId) {
    await runner.query(
      "UPDATE purchase_orders SET discount = LEAST(discount, " +
      "(SELECT COALESCE(SUM(line_cost), 0) FROM purchase_order_items WHERE po_id = ?)) WHERE po_id = ?",
      [poId, poId]);
    await runner.query("DELETE FROM purchase_order_items WHERE po_id = ? AND quantity <= 0", [poId]);
  }

  // Tells the manager and the clerk something about a purchase order
  async function tellManagerAndClerk(title, message) {
    await db.query(
      "INSERT INTO notifications (target_role_id, notif_type, title, message) " +
      "SELECT role_id, 'Purchase Order', ?, ? FROM roles WHERE role_name IN ('Manager', 'Inventory Clerk')",
      [title.slice(0, 150), message]);
    if (publishChange) {
      publishChange("notifications", "purchase order " + title, null);
      publishChange("inventory", "purchase order " + title, null);
    }
  }

  async function ensureSupplierCode(poId) {
    await db.query(
      "UPDATE purchase_orders SET supplier_code = ? WHERE po_id = ? AND supplier_code IS NULL",
      [crypto.randomBytes(32).toString("base64url"), poId]);
  }

  async function supplierAnswerLink(request, order) {
    if (order.status !== "Pending" && order.status !== "Incomplete") return null;
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

  app.get("/api/purchase-orders/:poId/document", async function (request, response) {
    try {
      const document = await readOrderDocument(request.params.poId);
      if (!document) {
        return response.status(404).json({ error: "That purchase order does not exist" });
      }
      const answer = await supplierAnswerLink(request, document.order);
      delete document.order.supplier_code;
      if (request.actor && request.actor.roleName === CASHIER) {
        for (let i = 0; i < document.items.length; i++) delete document.items[i].last_cost;
      }
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

    if (!/^\+?[\d\s\-()]*$/.test(String(contactNumber || "").trim())) {
      return response.status(400).json({
        error: "The contact number can only hold digits: 09XX XXX XXXX, or +63 9XX XXX XXXX."
      });
    }
    const phoneProblem = phoneComplaint(contactNumber);
    if (phoneProblem) {
      return response.status(400).json({ error: phoneProblem });
    }

    const lines = [];
    const lineDescriptions = [];
    const lineOfProduct = {};
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const pickedId = Number(item.productId || item.product_id) || null;
      if (pickedId) {
        if (lineOfProduct[pickedId]) {
          return response.status(400).json({
            error: "Line " + (i + 1) + " is the same product as line " + lineOfProduct[pickedId] + "."
          });
        }
        lineOfProduct[pickedId] = i + 1;
      }
      // Every line needs a material and a quantity, so an order can never be saved empty
      if (!pickedId && String(item.newName || item.new_name || "").trim() === "") {
        return response.status(400).json({ error: "Line " + (i + 1) + " has no product. Pick one or remove the line." });
      }
      if (!(Number(item.quantity) > 0)) {
        return response.status(400).json({ error: "Line " + (i + 1) + " needs a quantity above zero." });
      }
      const lineDescription = String(item.description || "").trim().replace(/\s+/g, " ");
      if (lineDescription.length > 255) {
        return response.status(400).json({ error: "A description is at most 255 characters." });
      }
      lineDescriptions.push(lineDescription);
      lines.push({
        product_id: Number(item.productId || item.product_id) || null,
        quantity: Number(item.quantity) || 0,
        new_name: shortText(item.newName || item.new_name, 150),
        brand_name: shortText(item.brandName || item.brand_name, 100),
        category_name: shortText(item.categoryName || item.category_name, 50),
        unit_name: shortText(item.unitName || item.unit_name, 20),
        pack_name: shortText(item.packName || item.pack_name, 20),
        pack_size: Number(firstGiven(item.packSize, item.pack_size)) || null,
        pack_count: Number(firstGiven(item.packCount, item.pack_count)) || null
      });
    }

    try {
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

      // The procedure does not take a description. It adds one row per line, in order,
      // so save each typed description on the row with the same position
      try {
        const savedRowsResult = await db.query(
          "SELECT po_item_id FROM purchase_order_items WHERE po_id = ? ORDER BY po_item_id", [output.po_id]);
        const savedRows = savedRowsResult[0];
        if (savedRows.length === lines.length) {
          for (let i = 0; i < lines.length; i++) {
            if (lineDescriptions[i] === "") continue;
            await db.query(
              "UPDATE purchase_order_items SET line_description = ? WHERE po_item_id = ?",
              [lineDescriptions[i], savedRows[i].po_item_id]
            );
          }
        }
      } catch (descriptionError) {
        console.error("The order was created, but its line descriptions were not saved:", descriptionError.message);
      }

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

  app.post("/api/purchase-orders/:poId/decide", async function (request, response) {
    const body = request.body || {};
    const approve = body.approve === true;
    let note = "";
    if (typeof body.note === "string") {
      note = body.note.trim().slice(0, 255);
    }
    if (!approve && note === "") {
      return response.status(400).json({ error: "Write the remarks: why the purchase order is declined." });
    }

    try {
      const poId = Number(request.params.poId);

      // An order with no items cannot be approved (declining it is still allowed)
      if (approve) {
        const countResult = await db.query("SELECT COUNT(*) AS line_count FROM purchase_order_items WHERE po_id = ?", [poId]);
        if (Number(countResult[0][0].line_count) === 0) {
          return response.status(409).json({ error: helpers.poNumber(poId) + " has no items, so it cannot be approved." });
        }
      }

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

      // The approval stands even when the email cannot go out; the order then stays To Send
      let emailed = { ok: false, problem: "Something went wrong while emailing it." };
      try {
        emailed = await emailOrderToSupplier(request, poId);
      } catch (error) {
        console.error("Emailing the approved purchase order failed:", error.message);
      }

      const number = helpers.poNumber(poId);
      if (emailed.ok) {
        response.json({
          message: "Purchase order " + number + " is approved and emailed to " + emailed.supplier + " at " + emailed.email + ".",
          status: "Pending",
          emailed: true
        });
      } else {
        response.json({
          message: "Purchase order " + number + " is approved, but it was not emailed: " + emailed.problem,
          status: "Pending",
          emailed: false
        });
      }
    } catch (error) {
      console.error("Purchase order decision failed:", error.message);
      response.status(500).json({ error: "Unable to record the decision" });
    }
  });

  // Emails an approved order to its supplier (PDF and accept link). Returns { ok: true, message, linked }
  // or { ok: false, status, problem }. Throws if something unexpected breaks.
  async function emailOrderToSupplier(request, poId) {
    // An order past its answer deadline is closed first, so it is not sent with a dead link
    await closeUnansweredOrders();
    const document = await readOrderDocument(poId);
    if (!document) return { ok: false, status: 404, problem: "That purchase order does not exist" };

    const order = document.order;
    const number = helpers.poNumber(order.po_id);
    if (order.status !== "Pending") {
      return {
        ok: false,
        status: 409,
        problem: order.status === "For Approval"
          ? number + " is not approved yet. The manager approves it before it goes to the supplier."
          : number + " is " + String(order.status).toLowerCase() + "; there is nothing to send."
      };
    }
    // An order with no items is never sent to a supplier
    if (document.items.length === 0) {
      return { ok: false, status: 409, problem: number + " has no items. Cancel it and raise a new order." };
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
            { order: Object.assign({}, order, { supplier_sent_at: order.supplier_sent_at || new Date() }) },
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
      return { ok: false, status: 400, problem: problem };
    }

    // The mail is out; a failure while recording it must not be reported as "not emailed"
    try {
      // Keep the first sent time: sending again must not give the supplier a fresh 12 hours
      await db.query("UPDATE purchase_orders SET supplier_sent_at = COALESCE(supplier_sent_at, NOW()) WHERE po_id = ?", [poId]);
      await writeAuditLog(request, "PURCHASE_ORDER_SENT", number + " emailed to " + order.supplier_name + " at " + email,
        { po_id: order.po_id, supplier: order.supplier_name, email: email, emailed: true });
    } catch (error) {
      console.error("Recording that " + number + " was emailed failed:", error.message);
    }

    return {
      ok: true,
      supplier: order.supplier_name,
      email: email,
      message: number + " was emailed to " + order.supplier_name + " at " + email + ", with the PDF and the link " +
               "to accept or decline it.",
      linked: Boolean(answer)
    };
  }

  app.post("/api/purchase-orders/:poId/send", async function (request, response) {
    const poId = Number(request.params.poId);

    try {
      const result = await emailOrderToSupplier(request, poId);
      if (!result.ok) return response.status(result.status).json({ error: result.problem });

      response.json({ message: result.message, linked: result.linked });
    } catch (error) {
      console.error("Sending the purchase order failed:", error.message);
      response.status(500).json({ error: "The order could not be sent. Print it and send it to the supplier." });
    }
  });

  app.post("/api/purchase-orders/:poId/mark-sent", async function (request, response) {
    const poId = Number(request.params.poId);
    try {
      const rowsResult = await db.query(
        "SELECT po.po_id, po.status, po.supplier_response, po.supplier_sent_at, s.supplier_name " +
        "FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ?", [poId]);
      const order = rowsResult[0][0];
      if (!order) return response.status(404).json({ error: "That purchase order does not exist" });

      const number = helpers.poNumber(order.po_id);
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

  // Emails the shortage notice of an Incomplete order. Returns { ok: true, supplier, email, message }
  // or { ok: false, status, problem }. Throws if something unexpected breaks.
  async function emailShortageToSupplier(request, poId) {
    const document = await readOrderDocument(poId);
    if (!document) return { ok: false, status: 404, problem: "That purchase order does not exist" };

    const order = document.order;
    const number = helpers.poNumber(order.po_id);
    if (order.status !== "Incomplete") {
      return { ok: false, status: 409, problem: number + " is not an incomplete delivery, so there is no shortage to send." };
    }

    const email = String(order.supplier_email || "").trim();
    let problem = null;
    if (!email) {
      problem = order.supplier_name + " has no email address on file. Print the shortage notice and send it to them.";
    } else if (!isMailConfigured()) {
      problem = "Mail is not set up on this server. Print the shortage notice and send it to " + order.supplier_name + ".";
    }

    const answer = await supplierAnswerLink(request, order);
    if (!problem) {
      try {
        await sendMail(await shortageMessage({
          order: Object.assign({}, order, { supplier_email: email }),
          lines: document.shortage.lines,
          total: document.shortage.total,
          shop: document.shop,
          link: answer ? answer.link : "",
          qr: answer ? answer.qr : null
        }));
      } catch (error) {
        console.error("Emailing the shortage notice for " + number + " failed:", error.message);
        problem = "The mail server refused the shortage notice for " + email + ": " + error.message + " " +
                  "Print the shortage notice and send it to them.";
      }
    }

    if (problem) {
      await writeAuditLog(request, "PURCHASE_ORDER_SHORTAGE_NOT_SENT",
        number + " shortage notice not emailed to " + order.supplier_name + ": " + problem,
        { po_id: order.po_id, supplier: order.supplier_name, email: email || null, emailed: false });
      return { ok: false, status: 400, problem: problem };
    }

    try {
      await db.query("UPDATE purchase_orders SET shortage_sent_at = NOW() WHERE po_id = ?", [poId]);
      await writeAuditLog(request, "PURCHASE_ORDER_SHORTAGE_SENT",
        number + " shortage notice emailed to " + order.supplier_name + " at " + email,
        { po_id: order.po_id, supplier: order.supplier_name, email: email, emailed: true,
          total_short: document.shortage.total });
    } catch (error) {
      console.error("Recording that the shortage notice for " + number + " was emailed failed:", error.message);
    }

    return {
      ok: true,
      supplier: order.supplier_name,
      email: email,
      message: "The shortage notice for " + number + " was emailed to " + order.supplier_name + " at " + email + "."
    };
  }

  app.post("/api/purchase-orders/:poId/shortage/send", async function (request, response) {
    const poId = Number(request.params.poId);

    try {
      const result = await emailShortageToSupplier(request, poId);
      if (!result.ok) return response.status(result.status).json({ error: result.problem });

      response.json({ message: result.message });
    } catch (error) {
      console.error("Sending the shortage notice failed:", error.message);
      response.status(500).json({ error: "The shortage notice could not be sent. Print it and send it to the supplier." });
    }
  });

  // The manager closes an incomplete delivery as it stands, when the supplier never answers
  app.post("/api/purchase-orders/:poId/close-short", async function (request, response) {
    const poId = Number(request.params.poId);
    const reason = String((request.body && request.body.reason) || "").trim().slice(0, 255);
    if (reason.length < 5) {
      return response.status(400).json({ error: "Write the reason the order is closed with a shortage." });
    }

    try {
      const document = await readOrderDocument(poId);
      if (!document) return response.status(404).json({ error: "That purchase order does not exist" });

      const order = document.order;
      const number = helpers.poNumber(poId);
      const neverArrived = order.status === "Pending" && order.supplier_response === "Accepted";
      if (order.status !== "Incomplete" && !neverArrived) {
        return response.status(409).json({
          error: number + " is not out for delivery or incomplete, so it cannot be closed with a shortage." });
      }
      if (neverArrived && order.price_review === "Waiting") {
        return response.status(409).json({
          error: number + " is waiting for the Manager to confirm the new prices." });
      }
      if (neverArrived && !order.supplier_ship_date) {
        return response.status(409).json({ error: number + " has no ship date yet. Cancel it instead." });
      }

      let shortLines = 0;
      let shortTotal = 0;
      if (neverArrived) {
        shortLines = document.items.length;
        for (let i = 0; i < document.items.length; i++) shortTotal += Number(document.items[i].line_cost || 0);
        shortTotal = Math.round(shortTotal * 100) / 100;

        // Nothing arrived: the order becomes a received order with nothing received
        const connection = await db.getConnection();
        try {
          await connection.beginTransaction();
          const closedNow = await connection.query(
            "UPDATE purchase_orders SET status = 'Received', received_at = NOW(), decision_note = ? " +
            "WHERE po_id = ? AND status = 'Pending' AND supplier_response = 'Accepted' " +
            "AND supplier_ship_date IS NOT NULL AND (price_review IS NULL OR price_review = 'Confirmed')",
            [reason, poId]);
          if (closedNow[0].affectedRows === 0) {
            await connection.rollback();
            return response.status(409).json({ error: number + " is no longer waiting for its delivery." });
          }
          await connection.query(
            "INSERT INTO purchase_order_ordered_items " +
            "(po_id, product_id, quantity, pack_name, pack_size, pack_count, unit_cost, line_description) " +
            "SELECT po_id, product_id, quantity, pack_name, pack_size, pack_count, unit_cost, line_description " +
            "FROM purchase_order_items WHERE po_id = ?", [poId]);
          await connection.query(
            "UPDATE purchase_order_items SET quantity = 0, " +
            "pack_count = IF(pack_size IS NULL OR pack_size <= 0, NULL, 0) WHERE po_id = ?", [poId]);
          await trimClosedOrder(connection, poId);
          await connection.commit();
        } catch (innerError) {
          try { await connection.rollback(); } catch (ignored) { }
          throw innerError;
        } finally {
          connection.release();
        }
      } else {
        shortLines = document.shortage.lines.length;
        shortTotal = document.shortage.total;

        const closed = await db.query(
          "UPDATE purchase_orders SET status = 'Received', received_at = NOW(), decision_note = ? " +
          "WHERE po_id = ? AND status = 'Incomplete'",
          [reason, poId]);
        if (closed[0].affectedRows === 0) {
          return response.status(409).json({ error: number + " is no longer an incomplete delivery." });
        }
        await trimClosedOrder(db, poId);
      }

      await writeAuditLog(request, "PO_CLOSED_SHORT",
        number + " closed with a shortage of " + pesoText(shortTotal) + ": " + reason,
        { po_id: poId, supplier: order.supplier_name, total_short: shortTotal });
      await tellManagerAndClerk(
        number + " closed with a shortage",
        number + " from " + order.supplier_name + " was closed with " + shortLines +
        (shortLines === 1 ? " line" : " lines") + " still short, " + pesoText(shortTotal) +
        " not delivered. Reason: " + reason);

      response.json({
        message: number + " is closed. " + pesoText(shortTotal) + " of the order was not delivered and is not paid for."
      });
    } catch (error) {
      console.error("Closing the purchase order with a shortage failed:", error.message);
      response.status(500).json({ error: "Unable to close the purchase order" });
    }
  });

  // Cancel Order: the shop withdraws an order whose goods have not arrived. The supplier's link stops working.
  // An order the supplier already accepted can be cancelled too, and the supplier is emailed.
  app.post("/api/purchase-orders/:poId/cancel", async function (request, response) {
    const poId = Number(request.params.poId);
    const reason = String((request.body && request.body.reason) || "").trim().slice(0, 255);
    if (reason.length < 5) {
      return response.status(400).json({ error: "Write why the order is cancelled." });
    }
    try {
      // An order that ran out of answer time is closed first, so it is reported as closed
      await closeUnansweredOrders();

      // An approved order can be cancelled when the supplier has not answered it, or accepted it
      // and nothing has been received yet (a received order is no longer Pending)
      const result = await db.query(
        "UPDATE purchase_orders SET status = 'Cancelled', closed_as = 'Cancelled', closed_note = ?, " +
        "closed_at = NOW(), closed_by_staff_id = ?, price_review = NULL WHERE po_id = ? AND status = 'Pending' " +
        "AND (supplier_response IS NULL OR supplier_response = 'Accepted')",
        [reason, getActorId(request), poId]);

      // The order and its supplier, for the messages below
      const rowsResult = await db.query(
        "SELECT po.status, po.supplier_response, s.supplier_name FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ?", [poId]);
      const order = rowsResult[0][0];
      if (!order) return response.status(404).json({ error: "That purchase order does not exist" });

      const number = helpers.poNumber(poId);
      if (result[0].affectedRows === 0) {
        if (order.status === "For Approval") {
          return response.status(409).json({ error: number + " is not approved yet. The manager can decline it instead." });
        }
        return response.status(409).json({ error: number + " is already closed." });
      }

      // The cancel does not change the supplier's answer, so this is what they had answered
      const wasAccepted = order.supplier_response === "Accepted";

      await writeAuditLog(request, "PURCHASE_ORDER_CANCELLED", number + " cancelled: " + reason,
        { po_id: poId, supplier: order.supplier_name, was_accepted: wasAccepted });
      if (publishChange) publishChange("inventory", "cancelled " + number, request.headers["x-client-id"] || null);

      if (!wasAccepted) {
        return response.json({ message: number + " is cancelled. " + order.supplier_name + "'s link no longer works." });
      }

      // The supplier had accepted it: tell the shop, and email the supplier when that is possible.
      // A failed email does not undo the cancel.
      let emailed = false;
      try {
        const document = await readOrderDocument(poId);
        const email = String(document.order.supplier_email || "").trim();
        if (email && isMailConfigured()) {
          await sendMail(cancelledOrderMessage({
            order: Object.assign({}, document.order, { supplier_email: email }),
            shop: document.shop,
            reason: reason
          }));
          emailed = true;
        }
      } catch (mailError) {
        console.error("The cancelled order was saved, but emailing the supplier failed:", mailError.message);
      }

      try {
        await tellManagerAndClerk(
          number + " cancelled",
          number + " to " + order.supplier_name + " was cancelled after they accepted it. Reason: " + reason);
      } catch (tellError) {
        console.error("The order was cancelled, but the notification failed:", tellError.message);
      }

      response.json({
        message: number + " is cancelled. " +
          (emailed ? order.supplier_name + " has been emailed." : "Tell " + order.supplier_name + " by phone.")
      });
    } catch (error) {
      console.error("Cancelling the purchase order failed:", error.message);
      response.status(500).json({ error: "Unable to cancel the purchase order" });
    }
  });

  // Emails the supplier a message built from the order. Returns true when it was sent, false when mail is
  // not set up or the supplier has no email. A failed email is logged and never undoes what was saved.
  async function mailSupplier(poId, buildMessage) {
    try {
      const document = await readOrderDocument(poId);
      const email = String(document.order.supplier_email || "").trim();
      if (!email || !isMailConfigured()) return false;
      await sendMail(buildMessage(Object.assign({}, document.order, { supplier_email: email }), document.shop));
      return true;
    } catch (mailError) {
      console.error("The order was saved, but emailing the supplier failed:", mailError.message);
      return false;
    }
  }

  // Why a price decision was refused: the order is missing, or not waiting for the manager
  async function priceReviewRefusal(poId) {
    const rowsResult = await db.query("SELECT po_id FROM purchase_orders WHERE po_id = ?", [poId]);
    if (!rowsResult[0][0]) return { status: 404, error: "That purchase order does not exist" };
    return { status: 409, error: helpers.poNumber(poId) + " is not waiting for the new prices to be confirmed." };
  }

  // The manager confirms the prices the supplier set. The order goes ahead and the supplier is emailed.
  app.post("/api/purchase-orders/:poId/confirm-prices", async function (request, response) {
    const poId = Number(request.params.poId);
    const number = helpers.poNumber(poId);
    try {
      const result = await db.query(
        "UPDATE purchase_orders SET price_review = 'Confirmed', price_review_at = NOW(), " +
        "price_review_by_staff_id = ? WHERE po_id = ? AND status = 'Pending' " +
        "AND supplier_response = 'Accepted' AND price_review = 'Waiting'",
        [getActorId(request), poId]);
      if (result[0].affectedRows === 0) {
        const refusal = await priceReviewRefusal(poId);
        return response.status(refusal.status).json({ error: refusal.error });
      }

      const orderResult = await db.query(
        "SELECT s.supplier_name FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ?", [poId]);
      const order = orderResult[0][0];

      await writeAuditLog(request, "PURCHASE_ORDER_PRICES_CONFIRMED",
        number + " confirmed at the prices set by " + order.supplier_name,
        { po_id: poId, supplier: order.supplier_name });

      // The supplier sets the ship date on the order link, so the email carries the link
      let shipLink = "";
      try {
        const codeResult = await db.query("SELECT supplier_code FROM purchase_orders WHERE po_id = ?", [poId]);
        const supplierCode = codeResult[0][0] ? codeResult[0][0].supplier_code : null;
        if (supplierCode) {
          shipLink = supplierOrderLink(request.protocol + "://" + request.get("host"), supplierCode) || "";
        }
      } catch (linkError) {
        console.error("The prices were confirmed, but the order link could not be made:", linkError.message);
      }
      const emailed = await mailSupplier(poId, function (mailOrder, shop) {
        return pricesConfirmedMessage({ order: mailOrder, shop: shop, link: shipLink });
      });

      try {
        await tellManagerAndClerk(
          number + " prices confirmed",
          "The new prices on " + number + " from " + order.supplier_name + " are confirmed. " +
          order.supplier_name + " sets the ship date next.");
      } catch (tellError) {
        console.error("The prices were confirmed, but the notification failed:", tellError.message);
      }

      response.json({
        message: number + " is confirmed. " +
          (emailed ? order.supplier_name + " has been emailed." : "Tell " + order.supplier_name + " by phone.")
      });
    } catch (error) {
      console.error("Confirming the prices failed:", error.message);
      response.status(500).json({ error: "Unable to confirm the prices" });
    }
  });

  // The manager denies the prices the supplier set. The order goes back to the supplier, who edits the
  // prices on the order link and answers again within the answer time. The supplier is emailed the link.
  app.post("/api/purchase-orders/:poId/deny-prices", async function (request, response) {
    const poId = Number(request.params.poId);
    const number = helpers.poNumber(poId);
    const reason = String((request.body && request.body.reason) || "").trim().slice(0, 255);
    if (reason.length < 5) {
      return response.status(400).json({ error: "Write why the prices are denied." });
    }
    try {
      const result = await db.query(
        "UPDATE purchase_orders SET supplier_response = NULL, supplier_responded_at = NULL, " +
        "supplier_ship_date = NULL, supplier_sent_at = NOW(), price_review = 'Denied', price_review_at = NOW(), " +
        "price_review_by_staff_id = ?, price_review_note = ? WHERE po_id = ? AND status = 'Pending' " +
        "AND supplier_response = 'Accepted' AND price_review = 'Waiting'",
        [getActorId(request), reason, poId]);
      if (result[0].affectedRows === 0) {
        const refusal = await priceReviewRefusal(poId);
        return response.status(refusal.status).json({ error: refusal.error });
      }

      const orderResult = await db.query(
        "SELECT s.supplier_name FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ?", [poId]);
      const order = orderResult[0][0];

      await writeAuditLog(request, "PURCHASE_ORDER_PRICES_DENIED",
        "The prices on " + number + " set by " + order.supplier_name + " were denied and sent back to edit: " + reason,
        { po_id: poId, supplier: order.supplier_name });
      if (publishChange) publishChange("inventory", "prices denied " + number, request.headers["x-client-id"] || null);

      // The supplier edits the prices on the order link, so the email carries the link
      let editLink = "";
      try {
        const codeResult = await db.query("SELECT supplier_code FROM purchase_orders WHERE po_id = ?", [poId]);
        const supplierCode = codeResult[0][0] ? codeResult[0][0].supplier_code : null;
        if (supplierCode) {
          editLink = supplierOrderLink(request.protocol + "://" + request.get("host"), supplierCode) || "";
        }
      } catch (linkError) {
        console.error("The prices were denied, but the order link could not be made:", linkError.message);
      }
      const emailed = await mailSupplier(poId, function (mailOrder, shop) {
        return pricesDeniedMessage({
          order: mailOrder, shop: shop, reason: reason, link: editLink, hours: SUPPLIER_ANSWER_HOURS
        });
      });

      try {
        await tellManagerAndClerk(
          number + " prices denied",
          "The new prices on " + number + " from " + order.supplier_name + " were denied. Reason: " + reason +
          ". " + order.supplier_name + " can edit the prices on the order link.");
      } catch (tellError) {
        console.error("The prices were denied, but the notification failed:", tellError.message);
      }

      response.json({
        message: "The prices on " + number + " are denied. " + order.supplier_name +
          " can edit them on the order link within " + SUPPLIER_ANSWER_HOURS + " hours. " +
          (emailed ? order.supplier_name + " has been emailed the link." : "Send " + order.supplier_name +
            " the order link by phone or message.")
      });
    } catch (error) {
      console.error("Denying the prices failed:", error.message);
      response.status(500).json({ error: "Unable to deny the prices" });
    }
  });

  // Delete Order: an order that is still waiting for the manager's approval can be removed for good
  app.delete("/api/purchase-orders/:poId", async function (request, response) {
    const poId = Number(request.params.poId);
    const number = helpers.poNumber(poId);

    let connection = null;
    let supplierName = "";
    let lineCount = 0;
    const removedProducts = [];
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();

      const orderResult = await connection.query(
        "SELECT po.status, po.order_date, s.supplier_name FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ? FOR UPDATE", [poId]);
      const order = orderResult[0][0];
      if (!order) {
        await connection.rollback();
        return response.status(404).json({ error: "That purchase order does not exist" });
      }
      if (order.status !== "For Approval") {
        await connection.rollback();
        return response.status(409).json({ error: number + " is already approved or closed, so it cannot be deleted." });
      }
      supplierName = order.supplier_name;

      const countResult = await connection.query(
        "SELECT COUNT(*) AS line_total FROM purchase_order_items WHERE po_id = ?", [poId]);
      lineCount = Number(countResult[0][0].line_total);

      // The products on the order lines, to look at once the order is gone
      const productResult = await connection.query(
        "SELECT p.product_id, p.product_name FROM products p WHERE p.product_id IN " +
        "(SELECT product_id FROM purchase_order_items WHERE po_id = ?)", [poId]);
      const lineProducts = productResult[0];

      await connection.query("DELETE FROM purchase_order_items WHERE po_id = ?", [poId]);
      await connection.query("DELETE FROM purchase_order_ordered_items WHERE po_id = ?", [poId]);
      await connection.query("DELETE FROM purchase_order_removed_items WHERE po_id = ?", [poId]);
      await connection.query("DELETE FROM purchase_orders WHERE po_id = ? AND status = 'For Approval'", [poId]);

      // A product this order created and nothing else uses goes with it: no stock, never bought,
      // on no other order, sale, stock movement or return, and made on or after the order.
      // If anything else holds on to the product, the delete is refused and the product stays.
      for (let i = 0; i < lineProducts.length; i++) {
        try {
          const gone = await connection.query(
            "DELETE FROM products WHERE product_id = ? AND last_cost IS NULL AND created_at >= ? " +
            "AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = products.product_id AND i.quantity_in_stock <> 0) " +
            "AND NOT EXISTS (SELECT 1 FROM purchase_order_items x WHERE x.product_id = products.product_id) " +
            "AND NOT EXISTS (SELECT 1 FROM purchase_order_ordered_items x WHERE x.product_id = products.product_id) " +
            "AND NOT EXISTS (SELECT 1 FROM purchase_order_removed_items x WHERE x.product_id = products.product_id) " +
            "AND NOT EXISTS (SELECT 1 FROM sale_items x WHERE x.product_id = products.product_id) " +
            "AND NOT EXISTS (SELECT 1 FROM stock_adjustments x WHERE x.product_id = products.product_id) " +
            "AND NOT EXISTS (SELECT 1 FROM returned_items x WHERE x.product_id = products.product_id)",
            [lineProducts[i].product_id, order.order_date]);
          if (gone[0].affectedRows > 0) removedProducts.push(lineProducts[i].product_name);
        } catch (productError) {
          console.error("A product on the deleted order was kept:", productError.message);
        }
      }
      await connection.commit();
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch (ignored) { }
      }
      console.error("Deleting the purchase order failed:", error.message);
      return response.status(500).json({ error: "Unable to delete the purchase order" });
    } finally {
      if (connection) connection.release();
    }

    try {
      await writeAuditLog(request, "PURCHASE_ORDER_DELETED",
        number + " to " + supplierName + " deleted, " + lineCount + (lineCount === 1 ? " line" : " lines") +
        (removedProducts.length > 0 ? ". Products removed with it: " + removedProducts.join("; ") : ""),
        { po_id: poId, supplier: supplierName, lines: lineCount, removed_products: removedProducts });
      if (publishChange) publishChange("inventory", "deleted " + number, request.headers["x-client-id"] || null);
    } catch (afterError) {
      console.error("The order was deleted, but logging it failed:", afterError.message);
    }

    response.json({ message: number + " is deleted." });
  });

  // Undo Receiving: a delivery was counted in but the goods never came. Every quantity received on the
  // order is taken back out of stock and the order goes back to Out for Delivery, as if nothing arrived.
  app.post("/api/purchase-orders/:poId/undo-receiving", async function (request, response) {
    const poId = Number(request.params.poId);
    const reason = String((request.body && request.body.reason) || "").trim().slice(0, 200);
    if (reason.length < 5) {
      return response.status(400).json({ error: "Write why the receiving is undone." });
    }
    const number = helpers.poNumber(poId);
    const receiptReason = "Received on purchase order #" + poId;

    let connection = null;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();

      // Lock the order so it cannot be received or undone twice at the same time
      const orderResult = await connection.query(
        "SELECT po.status, po.supplier_response, s.supplier_name FROM purchase_orders po " +
        "JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ? FOR UPDATE", [poId]);
      const order = orderResult[0][0];
      if (!order) {
        await connection.rollback();
        return response.status(404).json({ error: "That purchase order does not exist" });
      }
      if (order.status !== "Received" && order.status !== "Incomplete") {
        await connection.rollback();
        return response.status(409).json({ error: number + " has not been received, so there is nothing to undo." });
      }

      // What was received on this order, per material. Once anything is received the order lines
      // hold the received quantities (what was ordered is kept in purchase_order_ordered_items).
      const addedResult = await connection.query(
        "SELECT i.product_id, p.product_name, SUM(i.quantity) AS added " +
        "FROM purchase_order_items i JOIN products p ON p.product_id = i.product_id " +
        "WHERE i.po_id = ? GROUP BY i.product_id, p.product_name HAVING SUM(i.quantity) > 0", [poId]);
      const added = addedResult[0];
      if (added.length === 0) {
        await connection.rollback();
        return response.status(409).json({ error: "Nothing was counted in on " + number + ", so there is nothing to undo." });
      }

      const missingResult = await connection.query(
        "SELECT COUNT(*) AS reports FROM returned_items WHERE po_id = ? AND report_type = 'Missing'", [poId]);
      if (Number(missingResult[0][0].reports) > 0) {
        await connection.rollback();
        return response.status(409).json({
          error: "A missing-goods report was filed on " + number + ". Receiving cannot be undone once goods were reported missing." });
      }

      // The goods must still be in stock: what was sold or used cannot be taken back
      const removals = [];
      for (let i = 0; i < added.length; i++) {
        const quantity = Number(added[i].added) || 0;
        if (quantity <= 0) continue;
        const stockResult = await connection.query(
          "SELECT quantity_in_stock FROM inventory WHERE product_id = ? FOR UPDATE", [added[i].product_id]);
        const inStock = stockResult[0].length > 0 ? Number(stockResult[0][0].quantity_in_stock) : 0;
        if (inStock < quantity) {
          await connection.rollback();
          return response.status(409).json({
            error: "Only " + inStock + " of " + added[i].product_name + " are in stock, but " + quantity +
              " were received on " + number + ". Some were already sold or used, so the receiving cannot be undone." });
        }
        removals.push({ productId: added[i].product_id, quantity: quantity, before: inStock });
      }

      for (let i = 0; i < removals.length; i++) {
        const r = removals[i];
        await connection.query(
          "UPDATE inventory SET quantity_in_stock = quantity_in_stock - ? WHERE product_id = ?",
          [r.quantity, r.productId]);
        await connection.query(
          "INSERT INTO stock_adjustments (product_id, adjustment_type, quantity_before, quantity_change, " +
          "quantity_after, reason, adjusted_by_staff_id) VALUES (?, 'Remove', ?, ?, ?, ?, ?)",
          [r.productId, r.before, -r.quantity, r.before - r.quantity,
           ("Receiving undone on purchase order #" + poId + ": " + reason).slice(0, 255), getActorId(request)]);
      }

      // The old receipts stay in the stock history, marked undone, so the order counts no deliveries again
      await connection.query(
        "UPDATE stock_adjustments SET reason = CONCAT(reason, ' (undone)') WHERE reason = ?", [receiptReason]);

      // Put the order lines back to what was ordered, then the order back to Out for Delivery
      const orderedResult = await connection.query(
        "SELECT COUNT(*) AS lines_ordered FROM purchase_order_ordered_items WHERE po_id = ?", [poId]);
      if (Number(orderedResult[0][0].lines_ordered) > 0) {
        await connection.query("DELETE FROM purchase_order_items WHERE po_id = ?", [poId]);
        await connection.query(
          "INSERT INTO purchase_order_items " +
          "(po_id, product_id, quantity, unit_cost, pack_name, pack_size, pack_count, line_description) " +
          "SELECT po_id, product_id, quantity, COALESCE(unit_cost, 0), pack_name, pack_size, pack_count, line_description " +
          "FROM purchase_order_ordered_items WHERE po_id = ? ORDER BY ordered_item_id", [poId]);
        await connection.query("DELETE FROM purchase_order_ordered_items WHERE po_id = ?", [poId]);
      }
      await connection.query(
        "UPDATE purchase_orders SET status = 'Pending', supplier_response = 'Accepted', received_at = NULL, " +
        "delivery_remarks = NULL, shortage_sent_at = NULL, shortage_response = NULL, " +
        "shortage_responded_at = NULL, shortage_note = NULL WHERE po_id = ?", [poId]);

      await connection.commit();
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch (ignored) { }
      }
      console.error("Undoing the receiving of a purchase order failed:", error.message);
      return response.status(500).json({ error: "Unable to undo the receiving" });
    } finally {
      if (connection) connection.release();
    }

    try {
      await writeAuditLog(request, "PO_RECEIVING_UNDONE",
        "Receiving of " + number + " undone: " + reason, { po_id: poId });
      await tellManagerAndClerk(
        number + " receiving undone",
        "The receiving of " + number + " was undone: " + reason +
        ". The goods were taken out of stock and the order is out for delivery again.");
    } catch (afterError) {
      console.error("The receiving was undone, but logging it failed:", afterError.message);
    }

    response.json({ message: "The receiving of " + number + " was undone. The goods were taken out of stock and the order is out for delivery again." });
  });

  async function orderForCode(code) {
    const rowsResult = await db.query(
      "SELECT po_id FROM purchase_orders WHERE supplier_code = ?", [String(code)]);
    const rows = rowsResult[0];
    if (rows.length === 0) return null;
    return readOrderDocument(rows[0].po_id);
  }

  const UNKNOWN_LINK = "This link is not valid. Check it against the printed order, or contact the shop.";

  function supplierView(document) {
    const order = document.order;

    const viewItems = [];
    for (let i = 0; i < document.items.length; i++) {
      const item = document.items[i];
      viewItems.push({
        id: item.po_item_id,
        product_name: item.product_name, brand_name: item.brand_name, category_name: item.category_name,
        description: item.description,
        quantity: item.quantity, unit_name: item.unit_name, unit_cost: item.unit_cost, line_cost: item.line_cost,
        original_unit_cost: item.original_unit_cost,
        pack_name: item.pack_name, pack_size: item.pack_size, pack_count: item.pack_count,
        base_unit: item.unit_name || "unit", units: item.units
      });
    }

    return {
      order: {
        po_id: order.po_id,
        number: helpers.poNumber(order.po_id),
        status: order.status,
        order_date: order.confirmed_at || order.order_date,
        supplier_name: order.supplier_name,
        contact_person: order.contact_person,
        supplier_response: order.supplier_response,
        supplier_responded_at: order.supplier_responded_at,
        supplier_note: order.supplier_note,
        supplier_ship_date: order.supplier_ship_date,
        discount: order.discount,
        closed_as: order.closed_as,
        closed_at: order.closed_at,
        closed_note: order.closed_as === "Denied" ? order.closed_note : null,
        price_review: order.price_review,
        price_review_note: order.price_review === "Denied" ? order.price_review_note : null,
        answer_by: order.answer_by,
        can_respond: order.status === "Pending" && !order.supplier_response,
        can_set_ship_date: order.status === "Pending" && order.supplier_response === "Accepted" &&
          !order.supplier_ship_date && order.price_review !== "Waiting" && !order.closed_as,
        shortage_response: order.shortage_response,
        shortage_responded_at: order.shortage_responded_at,
        shortage_note: order.shortage_note,
        can_answer_shortage: order.status === "Incomplete" && !order.shortage_response
      },
      shortage: document.shortage || null,
      items: viewItems,
      removed: document.removed || [],
      shop: { store_name: document.shop.store_name, address: document.shop.address }
    };
  }

  app.get("/api/supplier-order/:code", async function (request, response) {
    try {
      await closeUnansweredOrders();
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
      await closeUnansweredOrders();
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });

      const number = helpers.poNumber(document.order.po_id);
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

  const PRICE_CEILING = 100000000;

  function calendarDay(offsetDays) {
    const day = new Date();
    day.setDate(day.getDate() + offsetDays);
    return isoDay(day);
  }

  function isoDay(day) {
    return day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" +
           String(day.getDate()).padStart(2, "0");
  }

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

    let asked = [];
    if (accept && Array.isArray(body.prices)) asked = body.prices;
    // The line ids the supplier removed. Only an accept uses them.
    let removedIds = [];
    if (accept && Array.isArray(body.removed)) removedIds = body.removed;

    let connection = null;
    try {
      await closeUnansweredOrders();
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });
      const order = document.order;
      const number = helpers.poNumber(order.po_id);

      // Find the removed lines on this order. A repeated id counts once.
      const removedLines = [];
      for (let i = 0; i < removedIds.length; i++) {
        let line = null;
        for (let n = 0; n < document.items.length; n++) {
          if (Number(document.items[n].po_item_id) === Number(removedIds[i])) line = document.items[n];
        }
        if (!line) {
          return response.status(400).json({
            error: "A line was removed that is not on this order. Reload the page and try again." });
        }
        if (removedLines.indexOf(line) === -1) removedLines.push(line);
      }
      if (removedLines.length > 0 && removedLines.length === document.items.length) {
        return response.status(400).json({ error: "Keep at least one line, or decline the order." });
      }
      // The lines that stay on the order
      const keptLines = [];
      for (let i = 0; i < document.items.length; i++) {
        if (removedLines.indexOf(document.items[i]) === -1) keptLines.push(document.items[i]);
      }

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
        // A removed line is going off the order, so its price does not matter
        if (removedLines.indexOf(item) !== -1) continue;
        const price = Math.round(Number(entry.unitCost) * 10000) / 10000;
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

      const repriced = [];
      let quoted = 0;
      for (let i = 0; i < changes.length; i++) {
        if (Number(changes[i].item.unit_cost) > 0) repriced.push(changes[i]);
        else quoted += 1;
      }

      if (accept) {
        for (let i = 0; i < keptLines.length; i++) {
          const item = keptLines[i];
          if (Number(item.unit_cost) > 0) continue;
          let priced = false;
          for (let n = 0; n < changes.length; n++) {
            if (changes[n].item === item) priced = true;
          }
          if (!priced) {
            return response.status(400).json({ error: "Enter a price above zero for " + item.product_name + "." });
          }
        }
      }

      let before = 0;
      for (let i = 0; i < keptLines.length; i++) {
        const item = keptLines[i];
        before += Number(item.line_cost || 0);
      }
      let after = before;
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        after += Math.round(change.price * Number(change.item.quantity) * 100) / 100 - Number(change.item.line_cost || 0);
      }

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

      // Lines whose price per unit is not what was paid on the last order, and lines for a product
      // that was never bought before. unit_cost and products.last_cost are both per base unit,
      // so they compare directly. Any such line sends the order to the manager to confirm.
      const lastPaidChanges = [];
      if (accept) {
        for (let i = 0; i < keptLines.length; i++) {
          const item = keptLines[i];
          const lastCost = Number(item.last_cost);
          let newPrice = Number(item.unit_cost);
          for (let n = 0; n < changes.length; n++) {
            if (changes[n].item === item) newPrice = changes[n].price;
          }
          if (!(lastCost > 0)) {
            lastPaidChanges.push({
              product: item.product_name, from: null, to: newPrice, unit: item.unit_name || "unit", first: true
            });
            continue;
          }
          if (Math.round(newPrice * 100) === Math.round(lastCost * 100)) continue;
          lastPaidChanges.push({
            product: item.product_name, from: lastCost, to: newPrice, unit: item.unit_name || "unit", first: false
          });
        }
      }
      let lastPaidText = "";
      let lastPaidList = "";
      let anyChanged = false;
      if (lastPaidChanges.length > 0) {
        const lastPaidParts = [];
        for (let i = 0; i < lastPaidChanges.length; i++) {
          const change = lastPaidChanges[i];
          if (change.first) {
            lastPaidParts.push(change.product + " " + pesoText(change.to) + " per " + change.unit + " (first order)");
          } else {
            anyChanged = true;
            lastPaidParts.push(change.product + " " + pesoText(change.from) + " to " + pesoText(change.to) +
              " per " + change.unit);
          }
        }
        lastPaidList = lastPaidParts.join("; ");
        lastPaidText = (anyChanged ? " Prices changed from the last order: " : " Prices to confirm: ") + lastPaidList + ".";
      }
      const needsReview = lastPaidChanges.length > 0;

      connection = await db.getConnection();
      await connection.beginTransaction();

      const queryResult = await connection.query(
        "UPDATE purchase_orders " +
        "SET supplier_response = ?, supplier_responded_at = NOW(), supplier_note = ?, supplier_ship_date = NULL, " +
        "discount = CASE WHEN ? THEN ? ELSE discount END, price_review = ? " +
        "WHERE po_id = ? AND status = 'Pending' AND supplier_response IS NULL " +
        "AND (supplier_sent_at IS NULL OR supplier_sent_at > NOW() - INTERVAL " + SUPPLIER_ANSWER_HOURS + " HOUR)",
        [accept ? "Accepted" : "Declined", note || null, accept, discount,
         needsReview ? "Waiting" : null, order.po_id]);
      const result = queryResult[0];

      if (result.affectedRows === 0) {
        await connection.rollback();
        connection.release();
        connection = null;
        // The time may have run out between the first read and the update, so close it now
        await closeUnansweredOrders();
        const again = await readOrderDocument(order.po_id);
        let why = number + " can no longer be answered here: it is " + String(again.order.status).toLowerCase() + ".";
        if (again.order.closed_as === "No Answer") {
          why = number + " expired on " + supplierTime(again.order.closed_at) + " without an answer. Contact the shop.";
        } else if (again.order.closed_as === "Cancelled") {
          why = number + " was cancelled by the shop. Contact the shop.";
        } else if (again.order.closed_as === "Denied") {
          why = number + " was denied by the shop. Contact the shop.";
        } else if (again.order.supplier_response) {
          why = number + " was already " + again.order.supplier_response.toLowerCase() + ". Contact the shop to change it.";
        }
        return response.status(409).json({ error: why, view: supplierView(again) });
      }

      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        await connection.query(
          "UPDATE purchase_order_items " +
          "SET original_unit_cost = IF(unit_cost > 0, COALESCE(original_unit_cost, unit_cost), original_unit_cost), " +
          "unit_cost = ? " +
          "WHERE po_item_id = ? AND po_id = ?",
          [change.price, change.item.po_item_id, order.po_id]);
      }

      // Move each removed line to the removed table
      for (let i = 0; i < removedLines.length; i++) {
        await connection.query(
          "INSERT INTO purchase_order_removed_items " +
          "(po_id, product_id, quantity, unit_cost, pack_name, pack_size, pack_count, line_description) " +
          "SELECT po_id, product_id, quantity, unit_cost, pack_name, pack_size, pack_count, line_description " +
          "FROM purchase_order_items WHERE po_item_id = ? AND po_id = ?",
          [removedLines[i].po_item_id, order.po_id]);
        await connection.query("DELETE FROM purchase_order_items WHERE po_item_id = ? AND po_id = ?",
          [removedLines[i].po_item_id, order.po_id]);
      }

      await connection.commit();
      connection.release();
      connection = null;

      // " They removed 2 lines they cannot supply: A; B."
      let removedText = "";
      if (removedLines.length > 0) {
        const removedNames = [];
        for (let i = 0; i < removedLines.length; i++) removedNames.push(removedLines[i].product_name);
        removedText = " They removed " + removedLines.length + " " + (removedLines.length === 1 ? "line" : "lines") +
                      " they cannot supply: " + removedNames.join("; ") + ".";
      }

      let title = order.supplier_name + " accepted purchase order " + helpers.poNumber(order.po_id);
      let message = order.supplier_name + " accepted " + number + ".";
      if (lastPaidChanges.length > 0) {
        title = order.supplier_name + " accepted purchase order " + helpers.poNumber(order.po_id) +
          (anyChanged ? " with price changes" : " with prices to confirm");
      }
      if (repriced.length > 0) {
        if (lastPaidChanges.length === 0) {
          title = order.supplier_name + " accepted purchase order " + helpers.poNumber(order.po_id) + " with new prices";
        }
        const priceChanges = [];
        for (let i = 0; i < repriced.length; i++) {
          const change = repriced[i];
          priceChanges.push(change.item.product_name + " " + pesoText(change.item.unit_cost) + " to " + pesoText(change.price));
        }
        message += " They changed the price on " + repriced.length + " " + (repriced.length === 1 ? "line" : "lines") + ": " +
                   priceChanges.join("; ") + ".";
      }
      if (quoted > 0) {
        message += " Order total " + pesoText(after) + ".";
      } else if (repriced.length > 0) {
        message += " Order total " + pesoText(before) + " to " + pesoText(after) + ".";
      }
      message += removedText;
      if (discount > 0) {
        message += " They gave a discount of " + pesoText(discount) + ", so the order comes to " + pesoText(after - discount) + ".";
      }
      if (!needsReview) message += " They will set the ship date on the order link.";
      // The Manager is asked to confirm the prices; the clerk is only told that the Manager will
      let managerMessage = message + lastPaidText + (lastPaidText ? " Confirm or deny the new prices on the order." : "");
      let clerkMessage = message + lastPaidText + (lastPaidText ? " The Manager confirms or denies the new prices." : "");
      if (note) {
        managerMessage += " Their note: " + note;
        clerkMessage += " Their note: " + note;
      }
      if (!accept) {
        title = order.supplier_name + " cannot fill purchase order " + helpers.poNumber(order.po_id);
        managerMessage = order.supplier_name + " declined " + number + ": " + note + " Order the products elsewhere, " +
                  "or contact the supplier.";
        clerkMessage = managerMessage;
      }
      await db.query(
        "INSERT INTO notifications (target_role_id, notif_type, title, message) " +
        "SELECT role_id, 'Purchase Order', ?, ? FROM roles WHERE role_name = 'Manager'",
        [title.slice(0, 150), managerMessage]);
      await db.query(
        "INSERT INTO notifications (target_role_id, notif_type, title, message) " +
        "SELECT role_id, 'Purchase Order', ?, ? FROM roles WHERE role_name = 'Inventory Clerk'",
        [title.slice(0, 150), clerkMessage]);

      let details = number + " declined by " + order.supplier_name + " from the link on the order: " + note;
      if (accept) {
        let priceNote = "";
        if (quoted > 0) {
          priceNote = ", prices set by the supplier, total " + pesoText(after);
        } else if (repriced.length > 0) {
          priceNote = ", " + repriced.length + " price(s) changed, total " + pesoText(before) + " to " + pesoText(after);
        }
        details = number + " accepted by " + order.supplier_name + " from the link on the order" +
          priceNote + removedText.replace(" They removed", ", removed").replace(/\.$/, "") +
          (discount > 0 ? ", discount " + pesoText(discount) : "") +
          (note ? ": " + note : "");
        if (lastPaidChanges.length > 0) {
          details += (anyChanged ? " (prices changed from the last order: " : " (prices to confirm: ") + lastPaidList + ")";
        }
      }
      const auditPrices = [];
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        auditPrices.push({ product: change.item.product_name, from: Number(change.item.unit_cost), to: change.price });
      }
      await writeAuditLog(request, accept ? "PURCHASE_ORDER_ACCEPTED" : "PURCHASE_ORDER_DECLINED_BY_SUPPLIER",
        details,
        { po_id: order.po_id, supplier: order.supplier_name, accepted: accept, discount: discount,
          prices: auditPrices, changed_from_last_order: lastPaidChanges });

      if (publishChange) {
        publishChange("notifications", "supplier answered " + number, null);
        publishChange("inventory", "supplier answered " + number, null);
      }

      response.json({
        message: accept
          ? (needsReview
            ? "Thank you. " + number + " is accepted. " + (document.shop.store_name || "The shop") +
              " will confirm the prices before you set the ship date."
            : "Thank you. " + number + " is accepted. Set the ship date below.")
          : "Thank you. " + (document.shop.store_name || "The shop") + " has been told that " + number + " cannot be filled.",
        view: supplierView(await readOrderDocument(order.po_id))
      });
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (ignored) {
        }
        connection.release();
      }
      console.error("Supplier response failed:", error.message);
      response.status(500).json({ error: "Your answer could not be saved. Try again in a moment." });
    }
  });

  // The supplier sets the ship date once the order is accepted and its prices are settled
  app.post("/api/supplier-order/:code/ship-date", async function (request, response) {
    const body = request.body || {};

    const shipDate = String(body.shipDate || "").trim();
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

    try {
      await closeUnansweredOrders();
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });
      const order = document.order;
      const number = helpers.poNumber(order.po_id);

      const queryResult = await db.query(
        "UPDATE purchase_orders SET supplier_ship_date = ? " +
        "WHERE po_id = ? AND status = 'Pending' AND supplier_response = 'Accepted' " +
        "AND supplier_ship_date IS NULL AND (price_review IS NULL OR price_review = 'Confirmed')",
        [shipDate, order.po_id]);

      if (queryResult[0].affectedRows === 0) {
        const again = await readOrderDocument(order.po_id);
        let why = number + " can no longer be answered here: it is " + String(again.order.status).toLowerCase() + ".";
        if (again.order.closed_as === "Cancelled") {
          why = number + " was cancelled by the shop. Contact the shop.";
        } else if (again.order.closed_as === "Denied") {
          why = number + " was denied by the shop. Contact the shop.";
        } else if (again.order.closed_as === "No Answer") {
          why = number + " expired without an answer. Contact the shop.";
        } else if (again.order.supplier_response === "Declined") {
          why = number + " was declined. Contact the shop.";
        } else if (!again.order.supplier_response) {
          why = number + " has not been accepted yet.";
        } else if (again.order.price_review === "Waiting") {
          why = "The shop is still confirming the prices on " + number + ". You can set the ship date after that.";
        } else if (again.order.supplier_ship_date) {
          why = "The ship date for " + number + " is already set. Contact the shop to change it.";
        }
        return response.status(409).json({ error: why, view: supplierView(again) });
      }

      const dateText = dayText(shipDate);
      const title = order.supplier_name + " set the ship date for " + number;
      const message = order.supplier_name + " will ship " + number + " on " + dateText + ".";

      // The date is saved; a failure while telling the shop must not turn into an error for the supplier
      try {
        await tellManagerAndClerk(title, message);
        await writeAuditLog(request, "PURCHASE_ORDER_SHIP_DATE_SET",
          number + " ship date set by " + order.supplier_name + " from the link on the order: " + shipDate,
          { po_id: order.po_id, supplier: order.supplier_name, ship_date: shipDate });
      } catch (afterError) {
        console.error("The ship date was saved, but the notification or log failed:", afterError.message);
      }

      response.json({
        message: "Thank you. " + number + " ships on " + dateText + ".",
        view: supplierView(await readOrderDocument(order.po_id))
      });
    } catch (error) {
      console.error("Setting the ship date failed:", error.message);
      response.status(500).json({ error: "The ship date could not be saved. Try again in a moment." });
    }
  });

  // The supplier says whether the rest of an incomplete delivery is coming
  app.post("/api/supplier-order/:code/shortage", async function (request, response) {
    const body = request.body || {};
    const deliver = body.deliver === true;
    const note = String(body.note || "").trim().slice(0, 255);

    if (!deliver && note.length < 5) {
      return response.status(400).json({ error: "Say why the rest cannot be delivered, so the shop can act on it." });
    }

    let shipDate = null;
    if (deliver) {
      shipDate = String(body.shipDate || "").trim();
      const parsed = new Date(shipDate + "T00:00:00");
      const real = /^\d{4}-\d{2}-\d{2}$/.test(shipDate) && !Number.isNaN(parsed.getTime()) &&
                   isoDay(parsed) === shipDate;
      if (!real) {
        return response.status(400).json({ error: "Pick the date the rest will be delivered." });
      }
      if (shipDate < calendarDay(0)) {
        return response.status(400).json({ error: "Pick today or a later date." });
      }
      if (shipDate > calendarDay(365)) {
        return response.status(400).json({ error: "Pick a date within the next year." });
      }
    }

    try {
      const document = await orderForCode(request.params.code);
      if (!document) return response.status(404).json({ error: UNKNOWN_LINK });
      const order = document.order;
      const number = helpers.poNumber(order.po_id);

      const updated = await db.query(
        "UPDATE purchase_orders " +
        "SET shortage_response = ?, shortage_responded_at = NOW(), shortage_note = ?, " +
        "supplier_ship_date = CASE WHEN ? THEN ? ELSE supplier_ship_date END, " +
        "status = CASE WHEN ? THEN 'Incomplete' ELSE 'Received' END, " +
        "received_at = CASE WHEN ? THEN received_at ELSE NOW() END " +
        "WHERE po_id = ? AND status = 'Incomplete' AND shortage_response IS NULL",
        [deliver ? "Will deliver" : "Cannot deliver", note || null, deliver, shipDate, deliver, deliver, order.po_id]);

      if (updated[0].affectedRows === 0) {
        const again = await readOrderDocument(order.po_id);
        let why = number + " can no longer be answered here: it is " + String(again.order.status).toLowerCase() + ".";
        if (again.order.status === "Incomplete" && again.order.shortage_response) {
          why = "The shortage on " + number + " was already answered. Contact the shop to change it.";
        }
        return response.status(409).json({ error: why, view: supplierView(again) });
      }

      const shortage = document.shortage;
      let title;
      let message;
      let details;
      if (deliver) {
        title = order.supplier_name + " will deliver the rest of purchase order " + number;
        message = order.supplier_name + " will deliver the rest of " + number + " (" + pesoText(shortage.total) +
                  " short) on " + dayText(shipDate) + "." + (note ? " Their note: " + note : "");
        details = number + " shortage answered by " + order.supplier_name + ": will deliver the rest on " + shipDate +
                  (note ? ": " + note : "");
      } else {
        await trimClosedOrder(db, order.po_id);
        title = order.supplier_name + " cannot deliver the rest of purchase order " + number;
        message = order.supplier_name + " cannot deliver the rest of " + number + " (" + pesoText(shortage.total) +
                  " short): " + note + " The order is closed as Received, and only what arrived is paid for.";
        details = number + " shortage answered by " + order.supplier_name + ": cannot deliver the rest: " + note;
      }
      await tellManagerAndClerk(title, message);
      await writeAuditLog(request, deliver ? "PO_SHORTAGE_WILL_DELIVER" : "PO_SHORTAGE_CANNOT_DELIVER", details,
        { po_id: order.po_id, supplier: order.supplier_name, deliver: deliver, ship_date: shipDate,
          total_short: shortage.total });

      response.json({
        message: deliver
          ? "Thank you. " + (document.shop.store_name || "The shop") + " has been told you will deliver the rest on " +
            dayText(shipDate) + "."
          : "Thank you. " + (document.shop.store_name || "The shop") + " has been told you cannot deliver the rest.",
        view: supplierView(await readOrderDocument(order.po_id))
      });
    } catch (error) {
      console.error("Supplier shortage answer failed:", error.message);
      response.status(500).json({ error: "Your answer could not be saved. Try again in a moment." });
    }
  });

  app.post("/api/purchase-orders/:poId/receive", async function (request, response) {
    let received;
    if (Array.isArray(request.body && request.body.received)) {
      received = request.body.received;
    } else {
      received = [];
    }

    const sheet = [];
    for (let i = 0; i < received.length; i++) {
      const line = received[i];
      sheet.push({
        product_id: Number(line.productId || line.product_id) || null,
        quantity: Math.max(0, Number(line.quantity) || 0),
        unit_cost: Math.round((Number(firstGiven(line.unitCost, line.unit_cost)) || 0) * 10000) / 10000,
        new_name: shortText(line.newName || line.new_name, 150),
        brand_name: shortText(line.brandName || line.brand_name, 100),
        category_name: shortText(line.categoryName || line.category_name, 50),
        unit_name: shortText(line.unitName || line.unit_name, 20)
      });
    }

    const body = request.body || {};
    // No discount posted keeps the one on the order
    const discount = body.discount === undefined || body.discount === null ? null : Math.max(0, Number(body.discount) || 0);
    // The number of deliveries the form saw counted in. A stale form no longer matches.
    const seen = body.seen === undefined || body.seen === null ? null : Number(body.seen);

    try {
      const stateResult = await db.query(
        "SELECT po.status, po.supplier_response, po.price_review, po.supplier_ship_date, s.supplier_name " +
        "FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ?",
        [Number(request.params.poId)]);
      const state = stateResult[0][0];
      if (!state) return response.status(404).json({ error: "That purchase order does not exist" });
      if (state.status === "Pending" && state.price_review === "Waiting") {
        return response.status(409).json({
          error: "Purchase order " + helpers.poNumber(request.params.poId) + " is waiting for the Manager to confirm the new prices."
        });
      }
      if (state.status === "Pending" && state.supplier_response === "Accepted" && !state.supplier_ship_date) {
        return response.status(409).json({
          error: helpers.poNumber(request.params.poId) + " is waiting for " +
            (state.supplier_name || "the supplier") + " to set the ship date."
        });
      }
      if (state.status === "Pending" && state.supplier_response !== "Accepted") {
        return response.status(409).json({
          error: "Purchase order " + helpers.poNumber(request.params.poId) + " can only be referred once the supplier has accepted it."
        });
      }

      // Receiving copies the lines into the ordered list without their descriptions, so keep them to copy across
      const typedResult = await db.query(
        "SELECT product_id, line_description FROM purchase_order_items " +
        "WHERE po_id = ? AND line_description IS NOT NULL AND line_description <> ''",
        [Number(request.params.poId)]
      );
      const typed = typedResult[0];

      const output = await inventoryClerkProcedures.receivePurchaseOrder(
        [request.params.poId, JSON.stringify(sheet), discount, getActorId(request), Number.isFinite(seen) ? seen : null]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // The delivery is counted in. Whatever fails from here on must not make the clerk send it again.
      try {
        try {
          for (let i = 0; i < typed.length; i++) {
            await db.query(
              "UPDATE purchase_order_ordered_items SET line_description = ? WHERE po_id = ? AND product_id = ?",
              [typed[i].line_description, Number(request.params.poId), typed[i].product_id]
            );
          }
        } catch (copyError) {
          console.error("The order was received, but its line descriptions were not copied:", copyError.message);
        }

        const remarks = shortText(body.remarks, 255);
        if (remarks) {
          await db.query("UPDATE purchase_orders SET delivery_remarks = ? WHERE po_id = ?",
            [remarks, Number(request.params.poId)]);
        }

        // A delivery that came in short leaves the order Incomplete: tell the people and the supplier
        const poId = Number(request.params.poId);
        const afterResult = await db.query("SELECT status FROM purchase_orders WHERE po_id = ?", [poId]);
        const incomplete = afterResult[0].length > 0 && afterResult[0][0].status === "Incomplete";
        if (!incomplete) {
          return response.json({ message: output.message, lines: output.lines, extras: output.extras, incomplete: false });
        }

        const number = helpers.poNumber(poId);
        const shortage = await readShortage(poId);
        let message = output.message;

        try {
          const supplierResult = await db.query(
            "SELECT s.supplier_name FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id WHERE po.po_id = ?",
            [poId]);
          await tellManagerAndClerk(
            number + " came in short",
            number + " from " + supplierResult[0][0].supplier_name + " came in short: " + shortage.lines.length +
            (shortage.lines.length === 1 ? " line is" : " lines are") + " still owed, " + pesoText(shortage.total) +
            " in all. The order stays Incomplete.");
        } catch (notifyError) {
          console.error("Telling the manager and clerk that " + number + " came in short failed:", notifyError.message);
        }

        // The receipt stands even when the notice cannot go out; the order stays Incomplete
        let emailed = { ok: false, problem: "Something went wrong while emailing it." };
        try {
          emailed = await emailShortageToSupplier(request, poId);
        } catch (mailError) {
          console.error("Emailing the shortage notice failed:", mailError.message);
        }
        if (emailed.ok) {
          message += " The supplier was emailed the shortage notice at " + emailed.email + ".";
        } else {
          message += " The supplier was not emailed: " + emailed.problem;
        }

        return response.json({
          message: message, lines: output.lines, extras: output.extras,
          incomplete: true, emailed: emailed.ok, total_short: shortage.total
        });
      } catch (afterError) {
        console.error("The delivery was counted in, but finishing up failed:", afterError.message);
        return response.json({ message: output.message, lines: output.lines, extras: output.extras });
      }
    } catch (error) {
      console.error("Receive PO failed:", error.message);
      response.status(500).json({ error: "Unable to receive the purchase order" });
    }
  });

  app.get("/api/returns", async function (request, response) {
    try {
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

  const RETURN_DISPOSITIONS = ["Return to Stock", "Write-Off"];
  const LONGEST_RETURN_REASON = 255;

  const QUANTITY_SLACK = 0.0005;
  const AMOUNT_SLACK = 0.01;

  async function refundProblem(saleId, productId, quantity, refundAmount) {
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

    if (refundAmount !== undefined && refundAmount !== null && refundAmount !== "") {
      const amountSent = Number(refundAmount);
      if (!Number.isFinite(amountSent) || amountSent < 0) {
        return response.status(400).json({ error: "The refund amount must be a number, zero or more." });
      }
    }

    if (reportType === "Refunded" && !saleId) {
      return response.status(400).json({ error: "A refund must be filed against a sale." });
    }

    const isDriver = request.actor && request.actor.roleName === DRIVER;

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
        if (!["Out for Delivery", "Delayed", "Delivered"].includes(deliveries[0].status)) {
          return response.status(409).json({ error: "Refund items once the delivery is out with the customer." });
        }
      } catch (error) {
        console.error("Driver refund check failed:", error.message);
        return response.status(500).json({ error: "Unable to check the refund" });
      }
    }

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
        reportType + " " + helpers.returnCode(output.report_id) + ": " + quantity + " unit(s), " + (where || "awaiting inspection"),
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
                      awaitingInspection: where === null, offBalance: Number(output.off_balance) || 0 });
    } catch (error) {
      console.error("File report failed:", error.message);
      response.status(500).json({ error: "Unable to file the report" });
    }
  });

  const REPORT_TYPES = ["Return", "Damaged", "Refunded", "Missing"];
  const MOST_REPORT_ITEMS = 50;

  app.post("/api/returns/batch", function (request, response) {
    return fileReportBatch(request, response, (request.body || {}).reportType);
  });

  app.post("/api/refunds", function (request, response) {
    return fileReportBatch(request, response, "Refunded");
  });

  async function fileReportBatch(request, response, reportType) {
    const body = request.body || {};

    if (!REPORT_TYPES.includes(reportType)) {
      return response.status(400).json({ error: "Pick the type of report." });
    }
    const isCashier = request.actor && request.actor.roleName === CASHIER;
    if (isCashier && reportType !== "Refunded") {
      return response.status(403).json({ error: "The counter files refunds only." });
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
        return response.status(400).json({ error: "An item in the report has no product." });
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return response.status(400).json({ error: "Every item needs a quantity greater than zero." });
      }
      if (!Number.isFinite(refund) || refund < 0) {
        return response.status(400).json({ error: "The refund amount must be a number, zero or more." });
      }
      if (reportType !== "Refunded" && reportType !== "Return") {
        refund = 0;
      }
      if (seen.includes(productId)) {
        return response.status(400).json({ error: "A product can be listed only once in a report." });
      }
      seen.push(productId);
      items.push({ product_id: productId, quantity: quantity, refund_amount: refund });
    }
    items.sort(function (a, b) { return a.product_id - b.product_id; });

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

    let where = null;
    if (isCashier) {
      where = null;
    } else if (reportType !== "Missing") {
      if (RETURN_DISPOSITIONS.includes(body.disposition)) {
        where = body.disposition;
      } else if (body.restock === true) {
        where = "Return to Stock";
      } else if (reportType !== "Refunded") {
        where = "Write-Off";
      }
    }

    try {
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
        reportType + " report for " + items.length + " item(s): " + reportIds.map(helpers.returnCode).join(", ") +
          (poId ? ", purchase order " + helpers.poNumber(poId) : ""),
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
  }

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
        let details = "Report " + helpers.returnCode(request.params.reportId) + " inspected: " + verdict;
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
