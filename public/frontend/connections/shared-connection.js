function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof CLIENT_ID === 'string') {
        headers['X-Client-ID'] = CLIENT_ID;
    }
    if (typeof userWasActiveLately === 'function' && !userWasActiveLately()) {
        headers['X-Background'] = '1';
    }
    return headers;
}

async function getJson(url) {
    const response = await fetch(url, { headers: apiHeaders() });
    if (!response.ok) {
        let body = null;
        try {
            body = await response.json();
        } catch (error) {
            body = null;
        }
        const visiting = document.documentElement.classList.contains('is-visiting');
        if (!(visiting && response.status === 403)) handleAuthFailure(response, body);
        const failure = new Error('request failed');
        failure.status = response.status;
        if (body && body.error) {
            failure.message = 'The server could not read this (' + response.status + '): ' + body.error;
            failure.handled = true;
        }
        throw failure;
    }
    return response.json();
}

async function postJson(url, data, method) {
    let sent = data;
    if (sent === undefined) {
        sent = {};
    }
    let usedMethod = 'POST';
    if (method) {
        usedMethod = method;
    }

    const response = await fetch(url, {
        method: usedMethod,
        headers: apiHeaders(),
        body: JSON.stringify(sent)
    });

    let body = null;
    try {
        body = await response.json();
    } catch (error) {
        body = null;
    }

    if (!response.ok) {
        if (!handleAuthFailure(response, body)) {
            notifyError((body && body.error) || 'That did not work.');
        }
        return null;
    }

    return body || {};
}

function sendJson(url, method, data) {
    return fetch(url, {
        method: method,
        headers: apiHeaders(),
        body: JSON.stringify(data)
    });
}

function apiSignIn(email, password) {
    return fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
    });
}

function apiSaveFirstPassword(newPassword) {
    return fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: newPassword })
    });
}

function apiSignOut() {
    if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/logout', new Blob([], { type: 'application/json' }));
    } else {
        fetch('/api/logout', { method: 'POST', headers: apiHeaders(), keepalive: true });
    }
}

function apiSendHeartbeat() {
    return fetch('/api/heartbeat', { method: 'POST', headers: apiHeaders() });
}

const LIVE_HIDDEN_POLL_MS = 30 * 1000;
let liveLastVersion = null;

function apiOpenLiveUpdates() {
    const listeners = {};
    let pollMs = 3000;
    let timer = null;
    let closed = false;
    let first = true;
    let failing = false;

    function emit(type, data) {
        const event = { data: JSON.stringify(data || {}) };
        const handlers = listeners[type] || [];
        for (let i = 0; i < handlers.length; i++) {
            try {
                handlers[i](event);
            } catch (error) {
                console.error(error);
            }
        }
    }

    async function ask() {
        timer = null;
        if (closed) return;

        try {
            let url = '/api/events/poll';
            if (liveLastVersion !== null) url += '?since=' + encodeURIComponent(liveLastVersion);
            const response = await fetch(url, { headers: apiHeaders(), cache: 'no-store' });
            if (closed) return;

            if (response.status === 401) {
                let body = {};
                try {
                    body = await response.json();
                } catch (error) {
                    body = {};
                }
                closed = true;
                emit('evicted', { reason: body.error });
                return;
            }
            if (!response.ok) throw new Error('HTTP ' + response.status);

            const body = await response.json();
            if (body.pollMs > 0) pollMs = body.pollMs;
            if (failing || first) emit('open');
            failing = false;

            if (body.gap) {
                emit('resync', { version: body.version });
            } else if (first) {
                const scopes = [];
                const changes = body.changes || [];
                for (let i = 0; i < changes.length; i++) {
                    if (scopes.indexOf(changes[i].scope) === -1) scopes.push(changes[i].scope);
                }
                emit('hello', { version: body.version, caughtUp: true, scopes: scopes });
            } else {
                const changes = body.changes || [];
                for (let i = 0; i < changes.length; i++) {
                    emit('change', changes[i]);
                }
            }
            first = false;
            liveLastVersion = body.version;
        } catch (error) {
            if (!failing) emit('error');
            failing = true;
        }

        schedule();
    }

    function schedule() {
        if (closed || timer) return;
        timer = setTimeout(ask, document.hidden ? Math.max(pollMs, LIVE_HIDDEN_POLL_MS) : pollMs);
    }

    document.addEventListener('visibilitychange', function () {
        if (closed || document.hidden || !timer) return;
        clearTimeout(timer);
        timer = null;
        ask();
    });

    ask();

    return {
        addEventListener: function (type, handler) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(handler);
        },
        close: function () {
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
        }
    };
}

function apiRequestResetCode(email) {
    return fetch('/api/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
    });
}

function apiVerifyResetCode(email, code) {
    return fetch('/api/password-reset/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code })
    });
}

function apiConfirmResetCode(email, code, newPassword) {
    return fetch('/api/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code, newPassword: newPassword })
    });
}

function apiGetMyAccount() {
    return fetch('/api/me', { headers: apiHeaders() });
}

function apiSaveMyDetails(data) {
    return sendJson('/api/me', 'PUT', data);
}

function apiChangeMyPassword(currentPassword, newPassword) {
    return sendJson('/api/me/password', 'POST', {
        currentPassword: currentPassword,
        newPassword: newPassword
    });
}

function apiGetMyScreens() {
    return getJson('/api/me/features');
}

function apiGetNotifications() {
    return getJson('/api/notifications');
}

function apiMarkNotificationRead(id) {
    return sendJson('/api/notifications/' + id + '/read', 'POST', {});
}

function apiMarkAllNotificationsRead() {
    return sendJson('/api/notifications/read-all', 'POST', {});
}

function apiGetProducts() {
    return getJson('/api/inventory/products?archived=false');
}

function apiGetRecords(type) {
    return getJson('/api/records/' + type);
}

function apiGetStoreSettings() {
    return getJson('/api/store-settings');
}

function apiGetSales(query) {
    return getJson('/api/sales' + query);
}

function apiGetSale(saleId) {
    return getJson('/api/sales/' + saleId);
}

function apiGetCreditCustomers() {
    return getJson('/api/credit/customers');
}

function apiGetCreditCustomer(customerId) {
    return getJson('/api/credit/customers/' + customerId);
}

function apiGetCreditTerms(customerId) {
    return getJson('/api/credit/terms/' + customerId);
}

function apiGetCustomerCard(customerId) {
    return getJson('/api/credit/card/' + customerId);
}

function apiGetPolicies() {
    return getJson('/api/policies');
}

function apiSavePolicy(kind, text, shownDefault) {
    return sendJson('/api/policies/' + kind, 'PUT', { text: text, shownDefault: shownDefault });
}

function apiGetCustomerHistory(customerId) {
    return getJson('/api/customers/' + customerId + '/history');
}

function apiGetCustomerLoyalty(customerId) {
    return getJson('/api/customers/' + customerId + '/loyalty');
}

function apiGetReturns() {
    return getJson('/api/returns');
}

function apiFileReturn(data) {
    return sendJson('/api/returns', 'POST', data);
}

function apiGetDeliveries() {
    return getJson('/api/deliveries');
}

function apiGetDeliveryItems(deliveryId) {
    return getJson('/api/deliveries/' + deliveryId + '/items');
}

function apiUpdateDeliveryStatus(deliveryId, status, remarks) {
    return sendJson('/api/deliveries/' + deliveryId + '/status', 'PATCH', {
        status: status,
        remarks: remarks
    });
}

function apiGetPurchaseOrders() {
    return getJson('/api/purchase-orders');
}

function apiGetPurchaseOrderItems(poId) {
    return getJson('/api/purchase-orders/' + poId + '/items');
}

function apiGetPurchaseOrderDocument(poId) {
    return getJson('/api/purchase-orders/' + poId + '/document');
}

function apiCreatePurchaseOrder(order) {
    return sendJson('/api/purchase-orders', 'POST', order);
}

function apiDecidePurchaseOrder(poId, approve, note) {
    return sendJson('/api/purchase-orders/' + poId + '/decide', 'POST', {
        approve: approve,
        note: note
    });
}

function apiSendPurchaseOrder(poId) {
    return sendJson('/api/purchase-orders/' + poId + '/send', 'POST', {});
}

function apiMarkPurchaseOrderSent(poId) {
    return sendJson('/api/purchase-orders/' + poId + '/mark-sent', 'POST', {});
}

function apiReceivePurchaseOrder(poId, received, discount, remarks) {
    return sendJson('/api/purchase-orders/' + poId + '/receive', 'POST', {
        received: received,
        discount: discount,
        remarks: remarks || null
    });
}

function apiGetPurchaseOrderReport(poId) {
    return getJson('/api/purchase-orders/' + poId + '/reports');
}

function apiCreateQrPayment(qr) {
    return sendJson('/api/qr-payments', 'POST', qr);
}

function apiGetQrPayment(id) {
    return getJson('/api/qr-payments/' + encodeURIComponent(id));
}

function apiCancelQrPayment(id) {
    return sendJson('/api/qr-payments/' + encodeURIComponent(id) + '/cancel', 'POST', {});
}
