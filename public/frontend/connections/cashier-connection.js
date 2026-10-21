function apiSaveSale(sale) {
    return sendJson('/api/sales', 'POST', sale);
}

function apiEditCustomer(customerId, customer) {
    return sendJson('/api/customers/' + customerId, 'PUT', customer);
}

function apiCreateCustomer(customer) {
    return sendJson('/api/customers', 'POST', customer);
}

function apiCreateDelivery(delivery) {
    return sendJson('/api/deliveries', 'POST', delivery);
}

function apiGetDeliveryDrivers() {
    return getJson('/api/deliveries/drivers');
}

function apiGetDailySummary(staffId) {
    return getJson('/api/cashier/summary?staffId=' + staffId);
}

function apiGetRecentSales() {
    return getJson('/api/sales?days=3');
}

function apiGetOpenSales() {
    return getJson('/api/credit/open-sales');
}

function apiRequestVoid(saleId, reason) {
    return sendJson('/api/sales/' + encodeURIComponent(saleId) + '/void-request', 'POST', { reason: reason });
}

function apiFileRefundBatch(data) {
    return sendJson('/api/returns/batch', 'POST', data);
}

function apiTakePayment(saleId, payment) {
    return sendJson('/api/sales/' + saleId + '/payment', 'POST', payment);
}

function apiAskCreditExtension(request) {
    return sendJson('/api/credit/requests', 'POST', request);
}
