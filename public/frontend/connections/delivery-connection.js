function apiGetMyDeliveries(staffId) {
    return getJson('/api/delivery/list?staffId=' + staffId);
}

function apiClaimDelivery(deliveryId) {
    return sendJson('/api/delivery/' + deliveryId + '/claim', 'POST', {});
}

function apiCollectPayment(deliveryId, payment) {
    return sendJson('/api/delivery/' + deliveryId + '/payment', 'POST', payment);
}

function apiGetDeliveryReport(staffId, from, to) {
    return getJson('/api/delivery/summary?staffId=' + staffId + '&from=' + from + '&to=' + to);
}
