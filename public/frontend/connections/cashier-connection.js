// ============================================================
// cashier-connection.js -- talking to the server (Cashier only)
// Loaded by: cashier-dashboard.html
//
// "get" functions give back the data; "send" functions give back the
// server's Response (see shared-connection.js for how to use them).
// ============================================================

// POST /api/sales -- ring up a sale
function apiSaveSale(sale) {
    return sendJson('/api/sales', 'POST', sale);
}

// PUT /api/customers/:id -- correct a customer's name, phone and address
function apiEditCustomer(customerId, customer) {
    return sendJson('/api/customers/' + customerId, 'PUT', customer);
}

// POST /api/customers -- open a customer account at the counter
function apiCreateCustomer(customer) {
    return sendJson('/api/customers', 'POST', customer);
}

// POST /api/deliveries -- create a delivery for a sale
function apiCreateDelivery(delivery) {
    return sendJson('/api/deliveries', 'POST', delivery);
}

// GET /api/deliveries/drivers -- the active drivers a delivery can be handed to
function apiGetDeliveryDrivers() {
    return getJson('/api/deliveries/drivers');
}

// GET /api/cashier/summary -- today's figures for this cashier
function apiGetDailySummary(staffId) {
    return getJson('/api/cashier/summary?staffId=' + staffId);
}

// GET /api/sales?days=3 -- every cashier's sales from today and the two days
// before, newest first (the Refunds screen picks a receipt from these).
// A voided sale is left out.
function apiGetRecentSales() {
    return getJson('/api/sales?days=3');
}

// GET /api/credit/open-sales -- every sale that still owes money
function apiGetOpenSales() {
    return getJson('/api/credit/open-sales');
}

// POST /api/returns/batch -- a refund of several items of one sale, in one report:
// { reportType: 'Refunded', saleId, reason, items: [{ productId, quantity, refundAmount }] }.
// All or nothing; the answer has offBalance (how much came off what the customer owes).
function apiFileRefundBatch(data) {
    return sendJson('/api/returns/batch', 'POST', data);
}

// POST /api/sales/:id/payment -- a Credit Settlement payment on a sale; the answer has the receipt
function apiTakePayment(saleId, payment) {
    return sendJson('/api/sales/' + saleId + '/payment', 'POST', payment);
}

// POST /api/credit/requests -- ask the manager for a higher credit limit
function apiAskCreditExtension(request) {
    return sendJson('/api/credit/requests', 'POST', request);
}
