// ============================================================
// delivery-connection.js -- talking to the server (Delivery Personnel only)
// Loaded by: delivery.html
//
// "get" functions give back the data; "send" functions give back the
// server's Response (see shared-connection.js for how to use them).
// ============================================================

// GET /api/delivery/list -- this driver's deliveries
function apiGetMyDeliveries(staffId) {
    return getJson('/api/delivery/list?staffId=' + staffId);
}

// POST /api/delivery/:id/claim -- the driver takes an unclaimed delivery
function apiClaimDelivery(deliveryId) {
    return sendJson('/api/delivery/' + deliveryId + '/claim', 'POST', {});
}

// POST /api/delivery/:id/payment -- cash collected at the door
function apiCollectPayment(deliveryId, payment) {
    return sendJson('/api/delivery/' + deliveryId + '/payment', 'POST', payment);
}

// GET /api/delivery/summary -- the driver's report between two dates
function apiGetDeliveryReport(staffId, from, to) {
    return getJson('/api/delivery/summary?staffId=' + staffId + '&from=' + from + '&to=' + to);
}
