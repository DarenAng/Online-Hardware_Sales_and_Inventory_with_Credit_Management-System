// ============================================================
// delivery-personnel.js -- the Delivery Personnel (driver) dashboard
// Loaded by: delivery.html
//
// What is in this file, from top to bottom:
//   - small date helpers (today, first day of the month)
//   - switching screens (showDeliveryPanel and the show... functions)
//   - the driver's deliveries: the one Pending list (every active delivery)
//   - taking a delivery (the status buttons live in the popup, shared/deliveries.js)
//   - Receive Payment: the popup that collects the money and marks the delivery Delivered
//   - refunding items the customer turns away at the door
//   - the driver's two reports (Deliveries Handled, Payments Collected), each with its own dates
//   - the page start-up code at the very bottom ("DELIVERY PAGE BOOT")
// ============================================================
let driverDeliveries = [];

function dateText(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
}

function todayText() { return dateText(new Date()); }

function monthStartText() {
    const now = new Date();
    return dateText(new Date(now.getFullYear(), now.getMonth(), 1));
}

function showDeliveryPanel(panelId, title, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    const heading = document.getElementById('del-page-title');
    if (heading) heading.textContent = title;

    leaveScreenFurniture();
}

// the default screen
function showDeliveryHome(event)   { showDeliveryPanel('panel-pending', 'Pending Deliveries', event); }
// the two reports in the sidebar
function showDeliveredReport(event) { showDeliveryPanel('panel-report-delivered', 'Deliveries Handled', event); }
function showPaymentsReport(event)  { showDeliveryPanel('panel-report-payments', 'Payments Collected', event); }

// Reads the driver's deliveries from the server. The popups find a delivery in
// driverDeliveries by its id, so every read keeps this list up to date.
async function fetchDriverDeliveries() {
    const user = getCurrentUser();
    if (!user) throw new Error('not signed in');

    driverDeliveries = await apiGetMyDeliveries(user.staff_id);
    return driverDeliveries;
}

// Re-reads the list after a change (taking a delivery, moving it, a payment)
// and redraws it in place: the list stays on screen, it never goes back to "not loaded".
async function loadDriverDeliveries() {
    const panel = getDataPanel('driver-pending');
    if (!panel) return;

    if (panel.state === 'ready') {
        await panel.refresh();
    } else {
        await panel.open();
    }

    if (panel.state === 'error') notifyOffline();
}

function isMine(d) {
    const user = getCurrentUser();
    return !!user && d.delivery_staff_id != null && Number(d.delivery_staff_id) === Number(user.staff_id);
}

// A delivery is still active until it is Delivered or Failed. That covers
// Pending, In Transit, Out for Delivery and Delayed.
function isActive(d) {
    return d.status !== 'Delivered' && d.status !== 'Failed';
}

// Every active delivery that is the driver's own or nobody's yet, so a new
// booking shows up at once. The list is always this whole list.
function pendingForDriver(d) {
    if (!isActive(d)) return false;
    return isMine(d) || d.delivery_staff_id == null;
}

// The Pending list mixes the driver's own deliveries with ones nobody has
// taken yet. The driver's own need no tag (the cashier assigned them), so
// only a delivery nobody has taken is marked.
function ownerTag(d) {
    if (isMine(d)) return '';
    return '<span class="badge badge-neutral owner-tag">Unassigned</span>';
}

// A Delayed delivery says why, in small muted words under its status
function delayedReason(d) {
    if (d.status !== 'Delayed' || !d.remarks) return '';
    return '<span class="delay-reason">Delayed: ' + escapeHtml(d.remarks) + '</span>';
}

// Clicking a delivery nobody has taken claims it for this driver first.
async function openPendingDelivery(deliveryId) {
    const d = driverDeliveries.find((x) => x.delivery_id === deliveryId);
    if (!d) return;

    if (!isMine(d)) {
        const yes = await askConfirm(
            'Delivery #' + deliveryId + ' to ' + d.customer_name + ' will be assigned to you.',
            { title: 'Take this delivery?', eyebrow: 'Deliveries', confirmLabel: 'Take Delivery', tone: 'accent' });
        if (!yes) return;

        try {
            const response = await apiClaimDelivery(deliveryId);
            const result = await response.json();

            if (!response.ok) {
                if (!handleAuthFailure(response, result)) notifyError(result.error);
                await loadDriverDeliveries();
                return;
            }

            notifySuccess(result.message);
        } catch (error) {
            notifyOffline();
            return;
        }

        // the list is read again so the delivery is now marked as the driver's
        await loadDriverDeliveries();
    }

    openDriverDetail(deliveryId);
}

function buildDriverPanels() {
    createDataPanel({
        key: 'driver-pending',
        tableId: 'dpend-table',
        columns: 5,
        pagerId: 'dpend-pager',
        idField: 'delivery_id',
        // the Status box and the scheduled From / To dates narrow the rows already loaded
        filters: { status: 'all', from: '', to: '' },
        gate: { title: 'Your deliveries are not loaded',
                text: 'Press Load Data to read your deliveries, or type a customer.',
                button: 'Load Data' },

        load: async () => {
            await fetchDriverDeliveries();
            return driverDeliveries.filter(pendingForDriver);
        },

        match: (d, query) => prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id], query),

        filter: (d, filters) => {
            if (filters.status !== 'all' && d.status !== filters.status) return false;

            // a date range only keeps deliveries that have a scheduled date inside it
            if (filters.from || filters.to) {
                const day = String(d.scheduled_date || '').slice(0, 10);
                if (!day) return false;
                if (filters.from && day < filters.from) return false;
                if (filters.to && day > filters.to) return false;
            }
            return true;
        },

        renderRow: (d, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openPendingDelivery(' + d.delivery_id + ')">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.delivery_address) + '</td>' +
            '<td class="cell-id">' + escapeHtml(d.scheduled_date || 'Not set') + '</td>' +
            '<td>' + statusBadge(d.status) + ' ' + ownerTag(d) + delayedReason(d) + '</td></tr>'
    });
}

// ---------- receive payment ----------
// Opens from "Proceed to Payment" in a delivery's card (shared/deliveries.js).
// Recording the payment also marks the delivery Delivered.
let paymentDeliveryId = null;
let paymentRemarks = null;     // the note typed in the delivery's card; it goes with Delivered

function openDriverPayment(deliveryId, remarks) {
    const d = driverDeliveries.find((x) => x.delivery_id === deliveryId);
    if (!d) {
        notifyWarning('Reload the list and open the delivery again.', 'Delivery not found');
        return;
    }

    paymentDeliveryId = deliveryId;
    paymentRemarks = remarks || null;

    document.getElementById('pay-subtitle').textContent = 'Delivery #' + deliveryId + ' · ' + d.customer_name;
    document.getElementById('pay-balance').textContent = peso(d.balance_due);

    // the amount starts as the whole balance; the driver can lower it but not go over it
    const form = document.getElementById('pay-form');
    form.elements.amount.max = Number(d.balance_due).toFixed(2);
    form.elements.amount.value = Number(d.balance_due).toFixed(2);
    form.elements.paymentMethod.value = 'Cash';
    form.elements.referenceNo.value = '';

    showModal('pay-modal');
}

// Cancel and the x: back to the delivery's card, with the remarks put back
function cancelDriverPayment() {
    const deliveryId = paymentDeliveryId;
    const remarks = paymentRemarks;

    closeModal('pay-modal');
    openDriverDetail(deliveryId);

    const box = document.getElementById('drec-remarks');
    if (box && remarks) box.value = remarks;
}

async function handleDriverPayment(event) {
    event.preventDefault();
    const form = event.target;

    const amount = parseFloat(form.elements.amount.value);
    if (!amount || amount <= 0) {
        notifyWarning('A payment has to be greater than zero.', 'Nothing recorded');
        return;
    }

    // how much was owed before this payment, to say what is left afterwards
    const d = driverDeliveries.find((x) => x.delivery_id === paymentDeliveryId);
    const owedBefore = d ? Number(d.balance_due) : 0;
    const stillOwed = Math.round((owedBefore - amount) * 100) / 100;

    // A part payment still closes the delivery, so it is asked about before anything is sent
    if (stillOwed > 0) {
        const yes = await askConfirm(
            peso(stillOwed) + ' will still be owed, and Delivery #' + paymentDeliveryId +
            ' will be closed as Delivered. The rest is collected at the counter.',
            { title: 'Record a part payment?', eyebrow: 'Delivery', confirmLabel: 'Record Payment', tone: 'accent' });
        if (!yes) return;
    }

    // The button is off while this sends, so a double tap cannot record the payment twice.
    const button = document.querySelector('#pay-modal button[type="submit"]');
    if (button && button.disabled) return;   // already sending
    if (button) button.disabled = true;

    let paymentRecorded = false;
    try {
        const response = await apiCollectPayment(paymentDeliveryId, {
                amount: amount,
                paymentMethod: form.elements.paymentMethod.value,
                referenceNo: form.elements.referenceNo.value.trim() || null
            });
        const result = await response.json();

        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }
        paymentRecorded = true;

        // the money is in, so the delivery is closed out as Delivered
        const statusResponse = await apiUpdateDeliveryStatus(paymentDeliveryId, 'Delivered', paymentRemarks);
        const statusResult = await statusResponse.json();

        closeModal('pay-modal');

        if (!statusResponse.ok) {
            // only an ended session (401) sends the driver to sign in; anything else says what happened
            if (statusResponse.status === 401) { handleAuthFailure(statusResponse, statusResult); return; }
            notifyError('The payment was recorded, but the delivery is not yet marked Delivered: ' +
                statusResult.error, 'Payment recorded');
        } else {
            let message = result.message + ' The delivery is marked Delivered.';
            if (stillOwed > 0) message += ' ' + peso(stillOwed) + ' is still owed.';
            notifySuccess(message, 'Delivery #' + paymentDeliveryId + ' delivered');
        }

        await refreshDeliveryLists();
    } catch (error) {
        if (paymentRecorded) {
            closeModal('pay-modal');
            notifyError('The payment was recorded, but the connection was lost before the delivery was marked ' +
                'Delivered. Open the delivery and mark it Delivered.', 'Payment recorded');
            await refreshDeliveryLists();
        } else {
            notifyOffline();
        }
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------- popup ----------
function openDriverDetail(deliveryId) {
    showDeliveryRecord(driverDeliveries.find((x) => x.delivery_id === deliveryId), true);
}

// ---------- refund at the door ----------
// An item the customer turns away at the door (damaged, wrong item). Each
// one is filed like a cashier's refund (POST /api/returns): it waits for the
// stockroom to inspect it. A refund comes off what the customer still owes;
// on an order already paid in full it is cash handed back instead.
const MINIMUM_DOOR_REASON = 10;
let refundDeliveryId = null;
let refundLines = [];     // what can still be refunded, one per sale line
let refundBalance = 0;    // what the order still owed when the form opened

async function openDriverRefund(deliveryId) {
    const d = driverDeliveries.find((x) => x.delivery_id === deliveryId);
    if (!d) return;

    let items;
    try {
        items = await apiGetDeliveryItems(deliveryId);
    } catch (error) {
        notifyOffline();
        return;
    }

    // Work out how much of each line can still go back. The shelf counts in
    // its own unit (base_quantity); the customer bought in the sold unit
    // (quantity), so one sold unit is "ratio" shelf units.
    refundLines = [];
    for (const it of items) {
        const sold = Number(it.quantity);
        const ratio = sold > 0 ? Number(it.base_quantity) / sold : 1;
        const leftBase = Number(it.base_quantity) - Number(it.refunded_quantity || 0);
        const left = Math.round((leftBase / ratio) * 1000) / 1000;
        // the lines add up to the sale total; the customer paid after the discount,
        // so a refund is worth the price actually charged
        let afterDiscount = 1;
        if (Number(it.sale_total) > 0) afterDiscount = Number(it.sale_final) / Number(it.sale_total);

        if (left > 0) {
            refundLines.push({
                productId: it.product_id,
                saleId: it.sale_id,
                name: it.product_name,
                unit: it.unit_name,
                sold: sold,
                left: left,
                ratio: ratio,
                price: Number(it.unit_price) * afterDiscount
            });
        }
    }

    if (refundLines.length === 0) {
        closeModal('refund-modal');
        notifyWarning('Everything on this delivery has already been refunded.', 'Nothing to refund');
        return;
    }

    refundDeliveryId = deliveryId;
    refundBalance = Number(d.balance_due) || 0;
    closeModal('detail-modal');

    document.getElementById('refund-subtitle').textContent = 'Delivery #' + deliveryId + ' · ' + d.customer_name;
    document.getElementById('refund-reason').value = '';

    let moneyNote = 'The order is already paid, so the refund is cash handed back to the customer.';
    if (refundBalance > 0) {
        moneyNote = 'The order still owes ' + peso(refundBalance) + ', so the refund comes off what the customer ' +
            'owes. If it is more than that, hand the rest back in cash.';
    }
    document.getElementById('refund-explain').textContent =
        'Tick each item the customer turned away and say how many. ' + moneyNote +
        ' The goods go to the inventory clerk for inspection.';

    document.getElementById('refund-lines').innerHTML = refundLines.map((line, i) =>
        '<div class="refund-line">' +
            '<label class="refund-pick"><input type="checkbox" id="refund-pick-' + i + '" onchange="onRefundLineChange()"> ' +
                escapeHtml(line.name) + '</label>' +
            '<span class="refund-sold muted">bought ' + escapeHtml(qtyText(line.sold, line.unit)) +
                ' at ' + peso(line.price) + ', up to ' + line.left + ' can go back</span>' +
            '<input type="number" class="form-control refund-qty" id="refund-qty-' + i + '" ' +
                'min="0" max="' + line.left + '" step="any" value="' + Math.min(1, line.left) + '" ' +
                'oninput="onRefundLineChange()" aria-label="Quantity of ' + escapeHtml(line.name) + '">' +
            '<span class="refund-amount" id="refund-amount-' + i + '"></span>' +
        '</div>'
    ).join('');

    onRefundLineChange();
    showModal('refund-modal');
}

// what each ticked line comes to, and the total, as the boxes change
function onRefundLineChange() {
    let total = 0;

    refundLines.forEach((line, i) => {
        const picked = document.getElementById('refund-pick-' + i).checked;
        const quantity = Number(document.getElementById('refund-qty-' + i).value) || 0;
        const amount = Math.round(quantity * line.price * 100) / 100;

        document.getElementById('refund-amount-' + i).textContent = picked ? peso(amount) : '';
        if (picked) total = total + amount;
    });

    // where the money goes: off the balance first, any rest is cash back
    let where = ' (cash handed back)';
    if (refundBalance > 0) {
        const off = Math.min(total, refundBalance);
        const back = Math.round((total - off) * 100) / 100;
        where = ' (' + peso(off) + ' off the balance' + (back > 0 ? ', ' + peso(back) + ' cash handed back' : '') + ')';
    }
    document.getElementById('refund-total').textContent = 'Refund total: ' + peso(total) + (total > 0 ? where : '');
}

async function handleDriverRefund(event) {
    event.preventDefault();

    const reason = document.getElementById('refund-reason').value.trim();

    // the lines that are ticked, checked one by one before anything is sent
    const chosen = [];
    for (let i = 0; i < refundLines.length; i++) {
        if (!document.getElementById('refund-pick-' + i).checked) continue;

        const line = refundLines[i];
        const quantity = Number(document.getElementById('refund-qty-' + i).value);

        if (!quantity || quantity <= 0 || quantity > line.left) {
            notifyWarning(line.name + ': the quantity must be more than zero and no more than ' + line.left + '.',
                'Nothing was filed');
            return;
        }
        if (!isMeasuredUnit(line.unit) && !Number.isInteger(quantity)) {
            notifyWarning(line.name + ' is counted in whole pieces.', 'Nothing was filed');
            return;
        }
        chosen.push({ line: line, quantity: quantity });
    }

    if (chosen.length === 0) {
        notifyWarning('Tick the item the customer turned away.', 'Nothing was filed');
        return;
    }
    if (reason.length < MINIMUM_DOOR_REASON) {
        notifyWarning('Say what was wrong, in a sentence. The stockroom reads this when it inspects the goods.',
            'The reason is required');
        document.getElementById('refund-reason').focus();
        return;
    }

    // Sent one at a time. The button is off meanwhile, so a double tap cannot
    // file the same refund twice.
    const button = document.querySelector('#refund-modal button[type="submit"]');
    if (button && button.disabled) return;   // already sending
    if (button) button.disabled = true;

    const filed = [];       // names of the items recorded
    const notFiled = [];    // "Name (why)" for each one that was not
    let offBalance = 0;     // how much of the refunds came off what the customer owes
    try {
        for (const pick of chosen) {
            const name = pick.line.name;

            // after a failure the rest are not tried: the same reason would likely stop them too
            if (notFiled.length > 0) {
                notFiled.push(name + ' (not tried)');
                continue;
            }

            try {
                const response = await apiFileReturn({
                    productId: pick.line.productId,
                    saleId: pick.line.saleId,
                    reportType: 'Refunded',
                    // the shelf counts in its own unit, so the sold quantity is converted
                    quantity: Math.round(pick.quantity * pick.line.ratio * 1000) / 1000,
                    reason: reason,
                    refundAmount: Math.round(pick.quantity * pick.line.price * 100) / 100
                });
                const result = await response.json();

                if (!response.ok) {
                    // a session that has ended is sent back to sign in
                    if (handleAuthFailure(response, result)) return;
                    notFiled.push(name + ' (' + result.error + ')');
                } else {
                    filed.push(name);
                    offBalance = offBalance + (Number(result.offBalance) || 0);
                }
            } catch (error) {
                notFiled.push(name + ' (the connection was lost)');
            }
        }

        if (filed.length > 0) await loadDriverDeliveries();

        if (notFiled.length === 0) {
            closeModal('refund-modal');
            let paidNote = '';
            if (offBalance > 0) paidNote = ' ' + peso(offBalance) + ' came off what the customer owes.';
            notifySuccess(filed.length + (filed.length === 1 ? ' item' : ' items') + ' set aside for the stockroom. ' +
                'The clerk has been asked to inspect ' + (filed.length === 1 ? 'it' : 'them') + '.' + paidNote,
                'Refund recorded');
            return;
        }

        // Something failed: say which is which and keep the form open. The
        // list is read again so what is left to refund is up to date, and the
        // reason typed is kept.
        let message = '';
        if (filed.length > 0) message = 'Recorded: ' + filed.join(', ') + '. ';
        message += 'Not recorded: ' + notFiled.join('; ') + '.';
        notifyError(message, filed.length > 0 ? 'Only some items were recorded' : 'Nothing was recorded');

        await openDriverRefund(refundDeliveryId);
        document.getElementById('refund-reason').value = reason;
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------- the reports ----------
// Two views, each with its own search box and its own From / To dates. The dates
// are sent to the server (it sends back the driver's report for that range); the
// search works on the rows that come back. A box left empty means this month so far.
function reportRange(fromId, toId) {
    const fromBox = document.getElementById(fromId);
    const toBox = document.getElementById(toId);

    if (fromBox && !fromBox.value) fromBox.value = monthStartText();
    if (toBox && !toBox.value) toBox.value = todayText();

    return { from: fromBox ? fromBox.value : '', to: toBox ? toBox.value : '' };
}

async function fetchDeliveryReport(fromId, toId) {
    const user = getCurrentUser();
    if (!user) throw new Error('not signed in');

    const range = reportRange(fromId, toId);
    return await apiGetDeliveryReport(user.staff_id, range.from, range.to);
}

// the report reloads once both dates are in; one alone waits for the other
function reportDatesPicked(key, fromId, toId) {
    const from = document.getElementById(fromId);
    const to = document.getElementById(toId);
    if (!from || !to || !from.value || !to.value) return;

    if (from.value > to.value) {
        notifyWarning('The start date is after the end date. Swap them and try again.',
            'That range runs backwards');
        return;
    }

    const panel = getDataPanel(key);
    if (panel) panel.open();
}

function buildReportPanels() {
    // Deliveries Handled: only deliveries that were delivered. The date is the day it was delivered.
    createDataPanel({
        key: 'driver-report',
        inputs: ['dhand-from', 'dhand-to'],
        tableId: 'drep-table',
        columns: 6,
        pagerId: 'drep-pager',
        idField: 'delivery_id',
        gate: { title: 'The report is not loaded',
                text: 'Pick the dates above, or press Load Data for this month so far.',
                button: 'Load Data' },

        load: async () => {
            const report = await fetchDeliveryReport('dhand-from', 'dhand-to');
            return report.deliveries.filter((d) => d.status === 'Delivered' && d.delivered_at);
        },

        match: (d, query) => prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id], query),

        renderRow: (d, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(d.delivered_at).slice(0, 10)) + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.delivery_address) + '</td>' +
            '<td class="cell-num">' + peso(d.final_amount) + '</td>' +
            '<td class="cell-num' + (Number(d.balance_due) > 0 ? ' cell-due' : '') + '">' + peso(d.balance_due) + '</td></tr>'
    });

    // Payments Collected: the date is the day the payment was taken
    createDataPanel({
        key: 'driver-report-pay',
        inputs: ['dpay-from', 'dpay-to'],
        tableId: 'drep-pay-table',
        columns: 5,
        pagerId: 'drep-pay-pager',
        idField: 'payment_id',
        gate: { title: 'The report is not loaded',
                text: 'Pick the dates above, or press Load Data for this month so far.',
                button: 'Load Data' },

        load: async () => {
            const report = await fetchDeliveryReport('dpay-from', 'dpay-to');
            return report.payments;
        },

        match: (p, query) => prefixMatch([p.customer_name, p.payment_method, p.reference_no], query),

        renderRow: (p, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-id">' + escapeHtml(String(p.payment_date).slice(0, 16)) + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.customer_name) + '</td>' +
            '<td>' + escapeHtml(p.payment_method) + '</td>' +
            '<td>' + (p.reference_no ? escapeHtml(p.reference_no) : '<span class="muted">None</span>') + '</td>' +
            '<td class="cell-num">' + peso(p.amount) + '</td></tr>'
    });
}

// ==========================================
// DELIVERY PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('delivery.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildDriverPanels();
        buildReportPanels();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: (panelId, title) => showDeliveryPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showDeliveryHome() });

        // Go to, on an opened alert: a new delivery is on the pending list
        configureNotificationTargets({
            'Delivery': { label: 'Pending Deliveries', panelId: 'panel-pending',
                          open: () => showDeliveryHome(), key: 'driver-pending' }
        });

        showDeliveryHome();
        loadNotifications();
    });
}
