// ============================================================
// shared-connection.js -- talking to the server (used by EVERY page)
// Loaded by: every page, right after format.js
//
// Every function that talks to the server starts with "api".
// There are two kinds:
//
//   1. "get" functions read data and give back the data itself:
//          const rows = await apiGetDeliveries();
//      They use getJson(), which throws an error if the request fails.
//
//   2. "send" functions change data and give back the server's Response:
//          const response = await apiUpdateDeliveryStatus(5, 'Delivered', '');
//          const result = await response.json();
//          if (!response.ok) { ...show result.error... }
//
// This file holds the calls that more than one kind of user needs.
// The calls for only one kind of user are in:
//   admin-connection.js, manager-connection.js, cashier-connection.js,
//   inventory-clerk-connection.js, delivery-connection.js
// ============================================================


// ==========================================
// BASIC HELPERS
// ==========================================

// The headers sent with every request. The sign-in itself travels in a
// cookie; X-Client-ID only names this browser tab, so the tab can recognise
// its own changes when the live updates come back.
// X-Background: 1 says "nobody has touched this page lately" (see
// userWasActiveLately in session.js). The live updates and the heartbeat go on
// asking while a page sits unused; the server must not count those asks as
// someone using the system, or a sign-in would never run out of idle time.
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

// Reads JSON data from the server. Throws an error when the request fails.
async function getJson(url) {
    const response = await fetch(url, { headers: apiHeaders() });
    if (!response.ok) {
        let body = null;
        try {
            body = await response.json();
        } catch (error) {
            body = null;
        }
        handleAuthFailure(response, body);
        throw new Error('request failed');
    }
    return response.json();
}

// Sends data to the server (POST, or the method given).
// Returns the answer on success and null when the server said no (its
// message is already on the screen). Throws only when the server cannot be
// reached, so the caller's catch is where notifyOffline() belongs.
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

// Sends data with any method (POST, PUT, PATCH) and gives back the Response.
function sendJson(url, method, data) {
    return fetch(url, {
        method: method,
        headers: apiHeaders(),
        body: JSON.stringify(data)
    });
}


// ==========================================
// SIGNING IN AND OUT
// ==========================================

// POST /api/login
function apiSignIn(email, password) {
    return fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
    });
}

// POST /api/change-password -- choosing your own password on first sign-in
function apiSaveFirstPassword(newPassword) {
    return fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: newPassword })
    });
}

// POST /api/logout -- sendBeacon still works while the page is closing
function apiSignOut() {
    if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/logout', new Blob([], { type: 'application/json' }));
    } else {
        fetch('/api/logout', { method: 'POST', headers: apiHeaders(), keepalive: true });
    }
}

// POST /api/heartbeat -- "this page is still open"
function apiSendHeartbeat() {
    return fetch('/api/heartbeat', { method: 'POST', headers: apiHeaders() });
}

// GET /api/events/poll -- the live updates ("inventory changed", ...)
// Asks the server every few seconds (it says how often) what changed since
// the last version seen: an open connection cannot be held on Vercel. Gives
// back an object raising the same events an EventSource did -- open, hello,
// change, resync, evicted, error -- so live-sync.js listens to it the same way.
// The last version is kept across reconnects, so nothing is missed.
const LIVE_HIDDEN_POLL_MS = 30 * 1000;   // a tab nobody is looking at asks less often
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
        (listeners[type] || []).forEach((handler) => {
            try { handler(event); } catch (error) { console.error(error); }
        });
    }

    async function ask() {
        timer = null;
        if (closed) return;

        try {
            let url = '/api/events/poll';
            if (liveLastVersion !== null) url += '?since=' + encodeURIComponent(liveLastVersion);
            const response = await fetch(url, { headers: apiHeaders(), cache: 'no-store' });
            if (closed) return;

            // signed out: somebody signed in elsewhere, the account was held, or it simply expired
            if (response.status === 401) {
                const body = await response.json().catch(() => ({}));
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
                // what changed while this page was away, each scope once
                const scopes = [];
                (body.changes || []).forEach((change) => {
                    if (scopes.indexOf(change.scope) === -1) scopes.push(change.scope);
                });
                emit('hello', { version: body.version, caughtUp: true, scopes: scopes });
            } else {
                (body.changes || []).forEach((change) => emit('change', change));
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

    // back to the tab: ask at once rather than waiting out the slow interval
    document.addEventListener('visibilitychange', function () {
        if (closed || document.hidden || !timer) return;
        clearTimeout(timer);
        timer = null;
        ask();
    });

    ask();

    return {
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        close() {
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
        }
    };
}

// POST /api/password-reset/request -- email a 6-digit code
function apiRequestResetCode(email) {
    return fetch('/api/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
    });
}

// POST /api/password-reset/confirm -- the code and the new password
function apiConfirmResetCode(email, code, newPassword) {
    return fetch('/api/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code, newPassword: newPassword })
    });
}


// ==========================================
// MY ACCOUNT, MY SCREENS, MY ALERTS
// ==========================================

// GET /api/me -- gives back the Response
function apiGetMyAccount() {
    return fetch('/api/me', { headers: apiHeaders() });
}

// PUT /api/me -- my name and phone number
function apiSaveMyDetails(data) {
    return sendJson('/api/me', 'PUT', data);
}

// POST /api/me/password
function apiChangeMyPassword(currentPassword, newPassword) {
    return sendJson('/api/me/password', 'POST', {
        currentPassword: currentPassword,
        newPassword: newPassword
    });
}

// GET /api/me/features -- which screens my menu shows
function apiGetMyScreens() {
    return getJson('/api/me/features');
}

// GET /api/notifications
function apiGetNotifications() {
    return getJson('/api/notifications');
}

// POST /api/notifications/:id/read
function apiMarkNotificationRead(id) {
    return sendJson('/api/notifications/' + id + '/read', 'POST', {});
}

// POST /api/notifications/read-all
function apiMarkAllNotificationsRead() {
    return sendJson('/api/notifications/read-all', 'POST', {});
}


// ==========================================
// SHARED LISTS
// ==========================================

// GET /api/inventory/products -- every product that is not archived
function apiGetProducts() {
    return getJson('/api/inventory/products?archived=false');
}

// GET /api/records/:type -- type is 'supplier', 'customer', 'product', 'category' or 'unit'
function apiGetRecords(type) {
    return getJson('/api/records/' + type);
}

// GET /api/store-settings -- the shop's name, address, TIN, ...
function apiGetStoreSettings() {
    return getJson('/api/store-settings');
}


// ==========================================
// SALES AND CREDIT (cashier and manager)
// ==========================================

// GET /api/sales -- query is '' or something like '?method=Cash&status=all'
function apiGetSales(query) {
    return getJson('/api/sales' + query);
}

// GET /api/sales/:id -- one sale with its items, payments, delivery and QR payments
function apiGetSale(saleId) {
    return getJson('/api/sales/' + saleId);
}

// GET /api/qr-payments -- every GCash/Maya QR attempt (a cashier gets their own),
// query like '?status=paid&from=2026-10-01'; the answer is { rows, summary, badge }
function apiGetQrPayments(query) {
    return getJson('/api/qr-payments' + (query || ''));
}

// GET /api/credit/customers
function apiGetCreditCustomers() {
    return getJson('/api/credit/customers');
}

// GET /api/credit/customers/:id
function apiGetCreditCustomer(customerId) {
    return getJson('/api/credit/customers/' + customerId);
}

// GET /api/customers/:id/history
function apiGetCustomerHistory(customerId) {
    return getJson('/api/customers/' + customerId + '/history');
}


// ==========================================
// RETURNS (cashier, inventory clerk, and the driver at the door)
// ==========================================

// GET /api/returns
function apiGetReturns() {
    return getJson('/api/returns');
}

// POST /api/returns -- file a refund, a return or a damage report
function apiFileReturn(data) {
    return sendJson('/api/returns', 'POST', data);
}


// ==========================================
// DELIVERIES (every dashboard shows them)
// ==========================================

// GET /api/deliveries
function apiGetDeliveries() {
    return getJson('/api/deliveries');
}

// GET /api/deliveries/:id/items -- what is being delivered
function apiGetDeliveryItems(deliveryId) {
    return getJson('/api/deliveries/' + deliveryId + '/items');
}

// PATCH /api/deliveries/:id/status
function apiUpdateDeliveryStatus(deliveryId, status, remarks) {
    return sendJson('/api/deliveries/' + deliveryId + '/status', 'PATCH', {
        status: status,
        remarks: remarks
    });
}


// ==========================================
// PURCHASE ORDERS (manager and inventory clerk)
// ==========================================

// GET /api/purchase-orders
function apiGetPurchaseOrders() {
    return getJson('/api/purchase-orders');
}

// GET /api/purchase-orders/:id/items
function apiGetPurchaseOrderItems(poId) {
    return getJson('/api/purchase-orders/' + poId + '/items');
}

// GET /api/purchase-orders/:id/document -- the printed order
function apiGetPurchaseOrderDocument(poId) {
    return getJson('/api/purchase-orders/' + poId + '/document');
}

// POST /api/purchase-orders -- the clerk raises a new order
function apiCreatePurchaseOrder(order) {
    return sendJson('/api/purchase-orders', 'POST', order);
}

// POST /api/purchase-orders/:id/decide -- the manager approves or declines
function apiDecidePurchaseOrder(poId, approve, note) {
    return sendJson('/api/purchase-orders/' + poId + '/decide', 'POST', {
        approve: approve,
        note: note
    });
}

// POST /api/purchase-orders/:id/send -- the clerk emails an approved order to its supplier
function apiSendPurchaseOrder(poId) {
    return sendJson('/api/purchase-orders/' + poId + '/send', 'POST', {});
}

// POST /api/purchase-orders/:id/receive -- the clerk counts the delivery in
function apiReceivePurchaseOrder(poId, received, discount) {
    return sendJson('/api/purchase-orders/' + poId + '/receive', 'POST', {
        received: received,
        discount: discount
    });
}
