// Every call to the portal's API. Each one gives back { ok, status, body }.
// A 401 means the customer session ended, so the page goes back to the log in page.
async function portalRequest(method, url, data) {
    const options = { method: method, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' };
    if (data !== undefined) options.body = JSON.stringify(data);

    const response = await fetch(url, options);
    let body = null;
    try {
        body = await response.json();
    } catch (error) {
        body = null;
    }

    if (response.status === 401 && url !== '/api/portal/login') {
        portalSignedOut((body && body.error) || '');
    }
    return { ok: response.ok, status: response.status, body: body || {} };
}

function apiPortalMe() { return portalRequest('GET', '/api/portal/me'); }
function apiPortalAccount() { return portalRequest('GET', '/api/portal/account'); }
function apiPortalCredits() { return portalRequest('GET', '/api/portal/credits'); }
function apiPortalPayments() { return portalRequest('GET', '/api/portal/payments'); }
function apiPortalLoyalty() { return portalRequest('GET', '/api/portal/loyalty'); }
function apiPortalLogout() { return portalRequest('POST', '/api/portal/logout', {}); }
function apiPortalChangePassword(passwords) { return portalRequest('POST', '/api/portal/password', passwords); }
function apiPortalCreateQr(request) { return portalRequest('POST', '/api/portal/qr-payments', request); }
function apiPortalQrStatus(id) { return portalRequest('GET', '/api/portal/qr-payments/' + id); }
function apiPortalCancelQr(id) { return portalRequest('POST', '/api/portal/qr-payments/' + id + '/cancel', {}); }
