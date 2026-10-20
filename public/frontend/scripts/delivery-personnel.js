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
//   - the driver's two reports (Deliveries Handled, Payments Collected), each with its own dates,
//     a filter and a Print / PDF button
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

    const panels = document.querySelectorAll('[data-panel]');
    for (let i = 0; i < panels.length; i++) {
        if (panels[i].id === panelId) {
            panels[i].style.display = 'block';
        } else {
            panels[i].style.display = 'none';
        }
    }
    const links = document.querySelectorAll('[data-panel-link]');
    for (let i = 0; i < links.length; i++) {
        links[i].classList.toggle('active', links[i].dataset.panelLink === panelId);
    }

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

// The driver's delivery with this id, or undefined when it is not in the list
function findDriverDelivery(deliveryId) {
    for (let i = 0; i < driverDeliveries.length; i++) {
        if (driverDeliveries[i].delivery_id === deliveryId) return driverDeliveries[i];
    }
    return undefined;
}

function isMine(d) {
    const user = getCurrentUser();
    return Boolean(user) && d.delivery_staff_id != null && Number(d.delivery_staff_id) === Number(user.staff_id);
}

// A delivery is still active until it is Delivered or Failed. That covers
// Pending, In Transit, Out for Delivery and Delayed.
function isActive(d) {
    return d.status !== 'Delivered' && d.status !== 'Failed';
}

// Every active delivery that is the driver's own or nobody's yet, so a new
// delivery shows up at once. The list is always this whole list.
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

// What the driver has to collect on a delivery, as a figure in the list; crimson
// when money is owed, a plain "Paid" when it is not, "On account" for a credit sale
// (that is paid at the counter, not at the door)
function collectCell(d) {
    if (d.payment_method === 'Credit') {
        return '<td class="cell-num"><span class="muted">On account</span></td>';
    }
    if (Number(d.balance_due) > 0) {
        return '<td class="cell-num cell-due">' + peso(d.balance_due) + '</td>';
    }
    return '<td class="cell-num"><span class="muted">Paid</span></td>';
}

// Clicking a delivery nobody has taken claims it for this driver first,
// straight away (no question asked), then opens its card.
async function openPendingDelivery(deliveryId) {
    const d = findDriverDelivery(deliveryId);
    if (!d) return;

    if (!isMine(d)) {
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
        columns: 6,
        pagerId: 'dpend-pager',
        idField: 'delivery_id',
        // the Status box and the scheduled From / To dates narrow the rows already loaded
        filters: { status: 'all', from: '', to: '' },
        gate: { title: 'Your deliveries are not loaded',
                text: 'Press Load Data to read your deliveries, or type a customer.',
                button: 'Load Data' },

        load: async function () {
            await fetchDriverDeliveries();
            const pending = [];
            for (let i = 0; i < driverDeliveries.length; i++) {
                if (pendingForDriver(driverDeliveries[i])) pending.push(driverDeliveries[i]);
            }
            return pending;
        },

        match: function (d, query) {
            return prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id], query);
        },

        filter: function (d, filters) {
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

        renderRow: function (d, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openPendingDelivery(' + d.delivery_id + ')">' +
                '<td class="cell-id">#' + d.delivery_id + '</td>' +
                // the Unassigned tag sits by the name, so it stays when a Status filter hides that column
                '<td class="cell-name">' + escapeHtml(d.customer_name) + ' ' + ownerTag(d) + '</td>' +
                '<td>' + escapeHtml(d.delivery_address) + '</td>' +
                '<td class="cell-id">' + escapeHtml(d.scheduled_date || 'Not set') + '</td>' +
                collectCell(d) +
                '<td>' + statusBadge(d.status) + '</td></tr>';
        }
    });
}

// ---------- receive payment ----------
// Opens from "Proceed Payment" in a delivery's card (shared/deliveries.js).
// Recording the payment also marks the delivery Delivered.
let paymentDeliveryId = null;
let paymentRemarks = null;     // the note typed in the delivery's card; it goes with Delivered

async function openDriverPayment(deliveryId, remarks) {
    let d = findDriverDelivery(deliveryId);

    // opened from the Delivery Schedule before Pending Deliveries was loaded: read the list now
    if (!d) {
        try {
            await fetchDriverDeliveries();
        } catch (error) {
            notifyOffline();
            return;
        }
        d = findDriverDelivery(deliveryId);
    }
    if (!d) {
        notifyWarning('Reload the list and open the delivery again.', 'Delivery not found');
        return;
    }

    paymentDeliveryId = deliveryId;
    paymentRemarks = remarks || null;

    document.getElementById('pay-subtitle').textContent = 'Delivery #' + deliveryId;
    // the customer is the delivery's own, filled in and not changed here
    document.getElementById('pay-customer').value = d.customer_name || '';

    // the amount starts empty, as at the counter: Short by reads the whole balance
    const form = document.getElementById('pay-form');
    form.elements.amount.value = '';
    form.elements.paymentMethod.value = 'Cash';
    clearPaymentDetails('door');
    onDriverPayMethodChange();
    onDriverPayAmountChange();

    showModal('pay-modal');
}

// A cheque is collected with the same details the counter takes: the account name and
// number printed on it, the bank and the date. GCash, PayMaya and a bank transfer are
// paid by a QR code the customer scans (qr-pay.js), as at the counter; for a transfer
// the customer's bank is picked from the ones PayMongo can take a transfer from.
// No reference is typed: a cheque is traced by its details, the rest by the QR payment.
buildPaymentDetailsBox('pay-details-box', 'door', true);

function onDriverPayMethodChange() {
    const form = document.getElementById('pay-form');
    if (!form) return;

    const method = form.elements.paymentMethod.value;
    showPaymentDetails('door', method);

    // Pay by QR is the only way to take GCash, PayMaya and a bank transfer;
    // Complete Sale takes cash and a cheque
    const byQr = QR_METHODS.indexOf(method) !== -1;
    const qrButton = document.getElementById('pay-qr-btn');
    if (qrButton) qrButton.hidden = !byQr;
    const saveButton = document.getElementById('pay-save-btn');
    if (saveButton) saveButton.hidden = byQr;

    // a bank transfer is for the whole balance, so there is no amount to type
    const amountField = document.getElementById('pay-amount-field');
    if (amountField) amountField.hidden = method === 'Bank Transfer';

    onDriverPayAmountChange();
}

// What the driver's form comes to: the balance, what is taken against it, the
// change handed back (cash only) and what is still owed afterwards.
function driverPayFigures() {
    const form = document.getElementById('pay-form');
    const d = findDriverDelivery(paymentDeliveryId);
    const due = d ? Number(d.balance_due) : 0;
    const method = form ? form.elements.paymentMethod.value : 'Cash';

    // a bank transfer is for the whole balance
    const entered = method === 'Bank Transfer' ? due : (parseFloat(form.elements.amount.value) || 0);
    const over = Math.round((entered - due) * 100) / 100;
    // cash handed over beyond the balance comes back as change; nothing else can go over
    const taken = Math.round(Math.min(entered, due) * 100) / 100;

    return {
        method: method,
        due: due,
        entered: entered,
        taken: taken,
        change: method === 'Cash' && over > 0 ? over : 0,
        tooMuch: method !== 'Cash' && over > 0 ? over : 0,
        left: Math.round((due - taken) * 100) / 100
    };
}

// the amount due, and what becomes of it, as the counter's Payment window shows it
function onDriverPayAmountChange() {
    const totals = document.getElementById('pay-totals');
    if (!totals || !findDriverDelivery(paymentDeliveryId)) return;

    const f = driverPayFigures();
    let html = '<div class="total-row total-due"><span>Amount Due</span><span>' + peso(f.due) + '</span></div>';

    if (f.method === 'Bank Transfer') {
        html += '<div class="total-row total-note"><span>Paid by bank transfer</span><span>' + peso(f.due) + '</span></div>';
    } else if (f.tooMuch > 0) {
        html += '<div class="total-row total-short"><span>More than the balance by</span><span>' + peso(f.tooMuch) + '</span></div>';
    } else if (f.left > 0) {
        html += '<div class="total-row total-short"><span>Short by</span><span>' + peso(f.left) + '</span></div>';
    } else {
        html += '<div class="total-row total-change"><span>Change</span><span>' + peso(f.change) + '</span></div>';
    }
    totals.innerHTML = html;

    // a QR code on screen is for the old amount; it is cancelled, not paid wrong
    qrAmountChanged('credit_payment', f.taken);
}

// Cancel and the x: back to the delivery's card
function cancelDriverPayment() {
    const deliveryId = paymentDeliveryId;

    closeModal('pay-modal');
    openDriverDetail(deliveryId);
}

// viaQr: pressed as Pay by QR; the money is taken by the QR code
async function handleDriverPayment(event, viaQr) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const form = document.getElementById('pay-form');

    // what is taken against the balance; cash over the balance is change handed back
    const d = findDriverDelivery(paymentDeliveryId);
    const figures = driverPayFigures();
    const amount = figures.taken;
    const stillOwed = figures.left;

    if (!(amount > 0)) {
        notifyWarning('Enter the amount the customer handed over.', 'Nothing recorded');
        const box = document.getElementById('pay-amount');
        if (box) box.focus();
        return;
    }

    // only cash can go over the balance (the rest is change); the server refuses it too
    if (figures.tooMuch > 0) {
        notifyWarning('The sale only owes ' + peso(figures.due) + '. Lower the amount entered.', 'More than is owed');
        return;
    }

    // GCash, PayMaya and a bank transfer are only taken by QR code, whichever way
    // the form was sent (Enter too)
    const method = form.elements.paymentMethod.value;
    viaQr = QR_METHODS.indexOf(method) !== -1;

    // the bank and account behind a cheque or a bank transfer
    let details = null;
    if (method === 'Cheque' || method === 'Bank Transfer') {
        let read;
        if (method === 'Cheque') read = readChequeDetails('door');
        else read = readTransferDetails('door');
        if (read.problem) {
            notifyWarning(read.problem, method + ' details needed');
            const box = document.getElementById(read.field);
            if (box) box.focus();
            return;
        }
        details = read.details;
    }

    // PayMongo refuses a transfer below the bank's smallest
    if (method === 'Bank Transfer') {
        const bank = paymongoBank(details.bankCode);
        if (bank && amount < bank.minimum) {
            notifyWarning(bank.name + ' takes transfers of ' + peso(bank.minimum) + ' or more. This one is ' +
                peso(amount) + '.', 'Too small for ' + bank.name);
            const box = document.getElementById('door-transfer-bank');
            if (box) box.focus();
            return;
        }
    }

    // A part payment still closes the delivery, so it is asked about before anything is sent
    if (stillOwed > 0) {
        const yes = await askConfirm(
            peso(stillOwed) + ' will still be owed, and Delivery #' + paymentDeliveryId +
            ' will be closed as Delivered. The rest is collected at the counter.',
            { title: 'Record a part payment?', eyebrow: 'Delivery', confirmLabel: 'Record Payment', tone: 'accent' });
        if (!yes) return;
    }

    // The buttons are off while this sends, so a double tap cannot record the payment twice.
    const button = document.getElementById('pay-save-btn');
    const qrButton = document.getElementById('pay-qr-btn');
    if ((button && button.disabled) || (qrButton && qrButton.disabled)) return;   // already sending
    if (button) button.disabled = true;
    if (qrButton) qrButton.disabled = true;

    // by QR code: the customer pays the code before anything is recorded
    let qr = null;
    if (viaQr) {
        const saleNumber = d && d.sale_id ? 'OR-' + String(d.sale_id).padStart(6, '0') : 'the sale';
        qr = await collectQrPayment(amount, 'Payment on ' + saleNumber + ' \u00b7 Delivery #' + paymentDeliveryId,
            method, 'credit_payment', d ? d.sale_id : null, method === 'Bank Transfer' ? details : null);
        if (!qr) {
            if (button) button.disabled = false;
            if (qrButton) qrButton.disabled = false;
            return;
        }
    }

    let paymentRecorded = false;
    try {
        const response = await apiCollectPayment(paymentDeliveryId, {
                amount: amount,
                paymentMethod: method,
                qrPaymentId: qr ? qr.id : null,
                paymentDetails: details
            });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) {
                let errorText = result.error + '';
                if (qr) errorText += keepUnusedQr(qr, result);
                notifyError(errorText);
            }
            return;
        }
        if (qr) qrPaidUnused = null;
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
            let message = peso(amount) + ' received by ' + form.elements.paymentMethod.value + '. The delivery is marked Delivered.';
            if (figures.change > 0) message += ' Change: ' + peso(figures.change) + '.';
            if (stillOwed > 0) message += ' ' + peso(stillOwed) + ' is still owed.';
            else message += ' The sale is paid in full.';
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
            if (qr) qrPaidUnused = qr;
            notifyOffline();
        }
    } finally {
        if (button) button.disabled = false;
        if (qrButton) qrButton.disabled = false;
    }
}

// ---------- popup ----------
function openDriverDetail(deliveryId) {
    showDeliveryRecord(findDriverDelivery(deliveryId), true);
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
    const d = findDriverDelivery(deliveryId);
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
    for (let n = 0; n < items.length; n++) {
        const it = items[n];
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


    let linesHtml = '';
    for (let i = 0; i < refundLines.length; i++) {
        const line = refundLines[i];
        linesHtml += '<div class="refund-line">' +
            '<label class="refund-pick"><input type="checkbox" id="refund-pick-' + i + '" onchange="onRefundLineChange()"> ' +
                escapeHtml(line.name) + '</label>' +
            '<span class="refund-sold muted">bought ' + escapeHtml(qtyText(line.sold, line.unit)) +
                ' at ' + peso(line.price) + ', up to ' + line.left + ' can go back</span>' +
            '<input type="number" class="form-control refund-qty" id="refund-qty-' + i + '" ' +
                'min="0" max="' + line.left + '" step="any" value="' + line.left + '" ' +
                'oninput="onRefundLineChange()" aria-label="Quantity of ' + escapeHtml(line.name) + '">' +
            '<span class="refund-amount" id="refund-amount-' + i + '"></span>' +
        '</div>';
    }
    document.getElementById('refund-lines').innerHTML = linesHtml;

    onRefundLineChange();
    showModal('refund-modal');
}

// what each ticked line comes to, and the total, as the boxes change
function onRefundLineChange() {
    let total = 0;

    for (let i = 0; i < refundLines.length; i++) {
        const line = refundLines[i];
        const picked = document.getElementById('refund-pick-' + i).checked;
        const quantity = Number(document.getElementById('refund-qty-' + i).value) || 0;
        const amount = Math.round(quantity * line.price * 100) / 100;

        if (picked) {
            document.getElementById('refund-amount-' + i).textContent = peso(amount);
            total = total + amount;
        } else {
            document.getElementById('refund-amount-' + i).textContent = '';
        }
    }

    // where the money goes: off the balance first, any rest is cash back
    let where = ' (cash handed back)';
    if (refundBalance > 0) {
        const off = Math.min(total, refundBalance);
        const back = Math.round((total - off) * 100) / 100;
        let backText = '';
        if (back > 0) backText = ', ' + peso(back) + ' cash handed back';
        where = ' (' + peso(off) + ' off the balance' + backText + ')';
    }
    let whereText = '';
    if (total > 0) whereText = where;
    document.getElementById('refund-total').textContent = 'Refund total: ' + peso(total) + whereText;
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
        for (let c = 0; c < chosen.length; c++) {
            const pick = chosen[c];
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
            let itemWord = ' items';
            let itWord = 'them';
            if (filed.length === 1) {
                itemWord = ' item';
                itWord = 'it';
            }
            notifySuccess(filed.length + itemWord + ' set aside for the stockroom. ' +
                'The clerk has been asked to inspect ' + itWord + '.' + paidNote,
                'Refund recorded');
            return;
        }

        // Something failed: say which is which and keep the form open. The
        // list is read again so what is left to refund is up to date, and the
        // reason typed is kept.
        let message = '';
        if (filed.length > 0) message = 'Recorded: ' + filed.join(', ') + '. ';
        message += 'Not recorded: ' + notFiled.join('; ') + '.';
        let errorTitle = 'Nothing was recorded';
        if (filed.length > 0) errorTitle = 'Only some items were recorded';
        notifyError(message, errorTitle);

        await openDriverRefund(refundDeliveryId);
        document.getElementById('refund-reason').value = reason;
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------- the Period box on each list ----------
// Pending Deliveries, Deliveries Handled and Payments Collected each pick their
// dates with one Period box. A named period fills the From and To boxes itself
// and keeps them out of sight; Custom date shows them for the driver to set.
// Pending has All as well (every active delivery, whatever its scheduled day).
const DRIVER_PERIODS = [
    ['today', 'Today', 0],
    ['7d', 'Last 7 days', 6],
    ['30d', 'Last 30 days', 29],
    ['90d', 'Last 90 days', 89],
    ['6m', 'Last 6 months', 182],
    ['12m', 'Last 12 months', 364]
];

// each list: what it starts on, and what it does once its dates have changed
const DRIVER_PERIOD_LISTS = {
    dpend: { first: 'all', apply: function (from, to) {
        dataPanelFilter('driver-pending', 'from', from);
        dataPanelFilter('driver-pending', 'to', to);
    } },
    dhand: { first: 'today', apply: function () { reportDatesPicked('driver-report', 'dhand-from', 'dhand-to'); } },
    dpay:  { first: 'today', apply: function () { reportDatesPicked('driver-report-pay', 'dpay-from', 'dpay-to'); } }
};

// the From and To a named period stands for ('' and '' for All)
function driverPeriodDates(value) {
    if (value === 'all') return { from: '', to: '' };
    for (let i = 0; i < DRIVER_PERIODS.length; i++) {
        if (DRIVER_PERIODS[i][0] !== value) continue;
        const start = new Date();
        start.setDate(start.getDate() - DRIVER_PERIODS[i][2]);
        return { from: dateText(start), to: todayText() };
    }
    return null;
}

function showDriverPeriodDates(prefix, show) {
    const ids = [prefix + '-from', prefix + '-to'];
    for (let i = 0; i < ids.length; i++) {
        const box = document.getElementById(ids[i]);
        const field = box ? box.closest('.toolbar-field') : null;
        if (field) field.hidden = !show;
    }
}

// fills each Period box with its choices, and its dates with its first period
function buildDriverPeriodBoxes() {
    for (const prefix in DRIVER_PERIOD_LISTS) {
        const select = document.getElementById(prefix + '-period');
        if (!select) continue;

        let html = prefix === 'dpend' ? '<option value="all">All</option>' : '';
        for (let i = 0; i < DRIVER_PERIODS.length; i++) {
            html += '<option value="' + DRIVER_PERIODS[i][0] + '">' + escapeHtml(DRIVER_PERIODS[i][1]) + '</option>';
        }
        html += '<option value="custom">Custom date...</option>';
        select.innerHTML = html;
        select.value = DRIVER_PERIOD_LISTS[prefix].first;

        const dates = driverPeriodDates(select.value);
        document.getElementById(prefix + '-from').value = dates.from;
        document.getElementById(prefix + '-to').value = dates.to;
        showDriverPeriodDates(prefix, false);
    }
}

// A Period box changed: Custom date shows the dates and waits for them; any
// other period fills them in and the list follows at once.
function driverPeriodPicked(prefix) {
    const select = document.getElementById(prefix + '-period');
    const list = DRIVER_PERIOD_LISTS[prefix];
    if (!select || !list) return;

    if (select.value === 'custom') {
        showDriverPeriodDates(prefix, true);
        const from = document.getElementById(prefix + '-from');
        if (from) from.focus();
        return;
    }

    showDriverPeriodDates(prefix, false);
    const dates = driverPeriodDates(select.value);
    document.getElementById(prefix + '-from').value = dates.from;
    document.getElementById(prefix + '-to').value = dates.to;
    list.apply(dates.from, dates.to);
}

// A list put back after a reload brings its dates back but not its Period box:
// dates that are not the period shown make the box read Custom date, with the
// dates beside it. Runs whenever a list changes.
function syncDriverPeriodBoxes() {
    for (const prefix in DRIVER_PERIOD_LISTS) {
        const select = document.getElementById(prefix + '-period');
        const from = document.getElementById(prefix + '-from');
        const to = document.getElementById(prefix + '-to');
        if (!select || !from || !to) continue;

        if (select.value !== 'custom') {
            const dates = driverPeriodDates(select.value);
            if (!dates || dates.from !== from.value || dates.to !== to.value) select.value = 'custom';
        }
        showDriverPeriodDates(prefix, select.value === 'custom');
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

// The dates each report was last read with, by panel key. A printout says
// these, not whatever the date boxes hold now (they may be changed but not reloaded).
const loadedReportRanges = {};

async function fetchDeliveryReport(key, fromId, toId) {
    const user = getCurrentUser();
    if (!user) throw new Error('not signed in');

    const range = reportRange(fromId, toId);
    loadedReportRanges[key] = range;
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
        // the Balance box narrows the rows already loaded
        filters: { balance: 'all' },
        gate: { title: 'The report is not loaded',
                text: 'Pick a period above, or press Load Data.',
                button: 'Load Data' },

        load: async function () {
            const report = await fetchDeliveryReport('driver-report', 'dhand-from', 'dhand-to');
            const handled = [];
            for (let i = 0; i < report.deliveries.length; i++) {
                const d = report.deliveries[i];
                if (d.status === 'Delivered' && d.delivered_at) handled.push(d);
            }
            return handled;
        },

        match: function (d, query) {
            return prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id], query);
        },

        filter: function (d, filters) {
            if (filters.balance === 'paid' && Number(d.balance_due) > 0) return false;
            if (filters.balance === 'owing' && !(Number(d.balance_due) > 0)) return false;
            return true;
        },

        renderRow: function (d, index) {
            let dueClass = '';
            if (Number(d.balance_due) > 0) dueClass = ' cell-due';
            return '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
                '<td class="cell-id">#' + d.delivery_id + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(d.delivered_at).slice(0, 10)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
                '<td>' + escapeHtml(d.delivery_address) + '</td>' +
                '<td class="cell-num">' + peso(d.final_amount) + '</td>' +
                '<td class="cell-num' + dueClass + '">' + peso(d.balance_due) + '</td></tr>';
        }
    });

    // Payments Collected: the date is the day the payment was taken
    createDataPanel({
        key: 'driver-report-pay',
        inputs: ['dpay-from', 'dpay-to'],
        tableId: 'drep-pay-table',
        columns: 6,
        pagerId: 'drep-pay-pager',
        idField: 'payment_id',
        // the Method box narrows the rows already loaded
        filters: { method: 'all' },
        gate: { title: 'The report is not loaded',
                text: 'Pick a period above, or press Load Data.',
                button: 'Load Data' },

        load: async function () {
            const report = await fetchDeliveryReport('driver-report-pay', 'dpay-from', 'dpay-to');
            return report.payments;
        },

        match: function (p, query) {
            return prefixMatch([p.customer_name, p.payment_method, p.reference_no, p.delivery_id ? '#' + p.delivery_id : ''], query);
        },

        filter: function (p, filters) {
            if (filters.method !== 'all' && p.payment_method !== filters.method) return false;
            return true;
        },

        renderRow: function (p, index) {
            return '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
                '<td class="cell-id">' + escapeHtml(String(p.payment_date).slice(0, 16)) + '</td>' +
                '<td class="cell-id">' + (p.delivery_id ? '#' + p.delivery_id : '<span class="muted">None</span>') + '</td>' +
                '<td class="cell-name">' + escapeHtml(p.customer_name) + '</td>' +
                '<td>' + escapeHtml(p.payment_method) + '</td>' +
                '<td>' + (paymentReference(p.payment_method, p.reference_no)
                    ? escapeHtml(paymentReference(p.payment_method, p.reference_no)) : '<span class="muted">None</span>') + '</td>' +
                '<td class="cell-num">' + peso(p.amount) + '</td></tr>';
        }
    });
}

// ---------- printing a report ----------
// Print / PDF opens the browser's print dialogue; "Save as PDF" is in that dialogue.
// Every row the filters leave is printed, under a small heading and above a Totals table.
// What each report needs for its printout:
const DRIVER_PRINTS = {
    'driver-report': {
        title: 'Deliveries Handled', searchId: 'dhand-search',
        filterName: 'Balance', filterKey: 'balance',
        filterLabels: { all: 'All', paid: 'Fully paid', owing: 'With balance' }
    },
    'driver-report-pay': {
        title: 'Payments Collected', searchId: 'dpay-search',
        filterName: 'Method', filterKey: 'method',
        filterLabels: { all: 'All' }   // a method is printed as its own name
    }
};

// set while a printout is on the page; calling it puts the screen back
let driverPrintRestore = null;

// A Print / PDF button works only when its report is loaded and has rows
function syncDriverPrintButtons() {
    const buttons = document.querySelectorAll('[data-print-report]');
    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        const panel = getDataPanel(button.dataset.printReport);
        const ready = Boolean(panel) && panel.state === 'ready' && panel.visible.length > 0;
        button.disabled = !ready;
        if (ready) {
            button.title = 'Print every row shown, or save it as a PDF';
        } else {
            button.title = 'Load data first';
        }
    }
}

// the lines above the table: report name, driver, dates and the filter chosen
function driverPrintHeading(key, panel) {
    const info = DRIVER_PRINTS[key];
    const user = getCurrentUser();
    const range = loadedReportRanges[key] || { from: '', to: '' };

    // the filter as the panel holds it, in words
    const filterValue = panel.filters[info.filterKey];
    const filterText = info.filterLabels[filterValue] || filterValue;

    let searchLine = '';
    // the words as they were typed in the search box (panel.query is lower-cased)
    const searchBox = document.getElementById(info.searchId);
    if (panel.query && searchBox) searchLine = '<p>Search: ' + escapeHtml(searchBox.value.trim()) + '</p>';

    const block = document.createElement('div');
    block.className = 'driver-print-heading';
    block.innerHTML =
        '<h2>' + escapeHtml(info.title) + '</h2>' +
        '<p>Driver: ' + escapeHtml(staffName(user)) + '</p>' +
        '<p>From ' + escapeHtml(range.from) + ' to ' + escapeHtml(range.to) + '</p>' +
        '<p>' + escapeHtml(info.filterName) + ': ' + escapeHtml(filterText) + '</p>' +
        searchLine;
    return block;
}

// the Totals table for the rows that are printed: [label, value] lines
function driverPrintTotals(key, rows) {
    const lines = [];
    let money = 0;

    if (key === 'driver-report') {
        let balance = 0;
        for (let i = 0; i < rows.length; i++) {
            money = money + (Number(rows[i].final_amount) || 0);
            balance = balance + (Number(rows[i].balance_due) || 0);
        }
        lines.push(['Deliveries', String(rows.length)]);
        lines.push(['Order Total', peso(money)]);
        lines.push(['Balance', peso(balance)]);
    } else {
        for (let i = 0; i < rows.length; i++) {
            money = money + (Number(rows[i].amount) || 0);
        }
        lines.push(['Payments', String(rows.length)]);
        lines.push(['Amount', peso(money)]);
    }

    let linesHtml = '';
    for (let i = 0; i < lines.length; i++) {
        linesHtml += '<tr><td>' + escapeHtml(lines[i][0]) + '</td><td class="cell-num">' + escapeHtml(lines[i][1]) + '</td></tr>';
    }

    const block = document.createElement('div');
    block.className = 'driver-print-totals';
    block.innerHTML = '<h3>Totals</h3><table><tbody>' + linesHtml + '</tbody></table>';
    return block;
}

function printDriverReport(key) {
    // a print still waiting to be put back (a second press) is finished first
    if (driverPrintRestore) driverPrintRestore();

    const panel = getDataPanel(key);
    const info = DRIVER_PRINTS[key];
    if (!panel || !info || panel.state !== 'ready' || panel.visible.length === 0) {
        notifyWarning('Load the report first. There is nothing on this screen to print yet.', 'Nothing to print');
        return;
    }

    // every filtered row goes on paper, not just the page being read
    const savedPageSize = panel.pageSize;
    const savedPage = panel.page;
    panel.pageSize = Math.max(1, panel.visible.length);
    panel.page = 1;
    panel.render();

    // the heading goes under the title, the Totals table after the rows
    const card = document.getElementById(panel.config.tableId).closest('.card');
    const head = driverPrintHeading(key, panel);
    const totals = driverPrintTotals(key, panel.visible);
    card.querySelector('.panel-head').after(head);
    card.appendChild(totals);

    document.body.classList.add('is-printing');

    // afterprint puts the screen back (no timer: a phone returns from print() at once)
    driverPrintRestore = function () {
        if (!driverPrintRestore) return;
        driverPrintRestore = null;
        document.body.classList.remove('is-printing');
        head.remove();
        totals.remove();
        panel.pageSize = savedPageSize;
        if (panel.state === 'ready') {
            panel.page = savedPage;
            panel.render();
        }
    };

    window.addEventListener('afterprint', function once() {
        window.removeEventListener('afterprint', once);
        if (driverPrintRestore) driverPrintRestore();
    });

    window.print();
}

// ==========================================
// DELIVERY PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('delivery.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildDriverPeriodBoxes();
        buildDriverPanels();
        buildReportPanels();

        // a list put back after a reload: its Period box follows the dates it came back with
        document.addEventListener('datapanel:change', syncDriverPeriodBoxes);

        // the Print / PDF buttons follow the reports: on once rows are showing
        document.addEventListener('datapanel:change', syncDriverPrintButtons);
        syncDriverPrintButtons();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: function (panelId, title) { showDeliveryPanel(panelId, title); } });
        buildDeliverySchedulePanel();
        configureFeatures({ home: function () { showDeliveryHome(); } });

        // Go to, on an opened alert: a new delivery is on the pending list
        configureNotificationTargets({
            'Delivery': { label: 'Pending Deliveries', panelId: 'panel-pending',
                          open: function () { showDeliveryHome(); }, key: 'driver-pending' }
        });

        showDeliveryHome();
        unfoldSidebarAtOpenScreen();
        loadNotifications();
    });
}
