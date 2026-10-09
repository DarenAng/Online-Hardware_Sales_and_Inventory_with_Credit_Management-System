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

// POST /api/customers -- open a customer account at the counter
function apiCreateCustomer(customer) {
    return sendJson('/api/customers', 'POST', customer);
}

// POST /api/deliveries -- book a delivery for a sale
function apiBookDelivery(delivery) {
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

// GET /api/credit/open-sales -- every sale that still owes money
function apiGetOpenSales() {
    return getJson('/api/credit/open-sales');
}

// POST /api/sales/:id/payment -- take a payment on a sale
function apiTakePayment(saleId, payment) {
    return sendJson('/api/sales/' + saleId + '/payment', 'POST', payment);
}

// POST /api/qr-payments -- a QR code for a GCash or PayMaya payment.
// qr is { amount, wallet, purpose: 'sale' or 'credit_payment', saleId };
// the answer has id, qrImage (a picture to show), payUrl, secondsLeft and badge
function apiCreateQrPayment(qr) {
    return sendJson('/api/qr-payments', 'POST', qr);
}

// GET /api/qr-payments/:id -- has the customer paid? { status, reference, errorMessage, secondsLeft }
function apiGetQrPayment(id) {
    return getJson('/api/qr-payments/' + encodeURIComponent(id));
}

// POST /api/qr-payments/:id/cancel -- give up on a code; the answer says how it
// ended, which is paid if the customer got there first
function apiCancelQrPayment(id) {
    return sendJson('/api/qr-payments/' + encodeURIComponent(id) + '/cancel', 'POST', {});
}

// POST /api/credit/requests -- ask the manager for a higher credit limit
function apiAskCreditExtension(request) {
    return sendJson('/api/credit/requests', 'POST', request);
}
