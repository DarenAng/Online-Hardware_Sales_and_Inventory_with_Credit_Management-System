// supplier-order.js -- the page a supplier opens from the QR code or link on
// the purchase order (printed, or emailed by the clerk)
// Loaded by: supplier-order.html only. Nobody signs in here: the code in the
// address (?code=...) is the supplier's permission, and the server checks it
// on every call (GET /api/supplier-order/:code, .../pdf, POST .../respond).
//
// One column, read top to bottom, every action a real button:
//   1. The order      each line has an Edit price button for a price that
//                     does not match what the supplier sells it for
//   2. Your answer    two big buttons: Accept order, Decline order
//   3. The details    accepting: the day it ships and a note; declining: why
//   and one big Send button at the end, with what will be sent written above it.
// Once answered, the page turns into the receipt of what was said.

(function () {
    const main = document.getElementById('so-main');
    const code = new URLSearchParams(window.location.search).get('code') || '';
    let view = null;            // { order, items, shop } as the server last gave it

    // what the supplier has said so far, before it is sent
    const draft = {
        decision: '',           // '', 'accept' or 'decline'
        prices: {},             // line id -> the supplier's price, once saved
        editing: {},            // line id -> true while its price box is open
        discount: '',           // off the whole order, as typed
        discountType: 'amount', // 'amount' (pesos) or 'percent'
        shipDate: '',           // YYYY-MM-DD
        note: '',
        reason: ''
    };

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function peso(value) {
        return '₱' + Number(value || 0).toLocaleString('en-PH',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function quantityText(value) {
        const number = Number(value || 0);
        if (Number.isInteger(number)) return String(number);
        return number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    }

    // "2 box (40 kilogram)" for a line ordered in packs; "40 kilogram" otherwise
    function lineQuantity(item) {
        const unit = item.unit_name || 'units';
        if (item.pack_name && Number(item.pack_size) > 0 && Number(item.pack_count) > 0) {
            return quantityText(item.pack_count) + ' ' + item.pack_name +
                ' (' + quantityText(item.quantity) + ' ' + unit + ')';
        }
        return quantityText(item.quantity) + ' ' + unit;
    }

    function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

    // ---------- days ----------
    function isoDay(day) {
        return day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' +
               String(day.getDate()).padStart(2, '0');
    }

    function dayFromNow(days) {
        const day = new Date();
        day.setDate(day.getDate() + days);
        return isoDay(day);
    }

    function asDay(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00:00'); }

    // "Monday, Oct 12"
    function dayText(iso, withYear) {
        if (!iso) return '';
        const options = { weekday: 'long', month: 'short', day: 'numeric' };
        if (withYear) options.year = 'numeric';
        return asDay(iso).toLocaleDateString('en-PH', options);
    }

    // "today", "tomorrow", "in 4 days"
    function daysAway(iso) {
        const days = Math.round((asDay(iso) - asDay(dayFromNow(0))) / 86400000);
        if (days === 0) return 'today';
        if (days === 1) return 'tomorrow';
        return 'in ' + days + ' days';
    }

    function stampText(value) {
        const text = String(value || '').replace(' ', 'T');
        const when = new Date(text);
        if (Number.isNaN(when.getTime())) return String(value || '');
        return when.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) +
            ', ' + when.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    }

    // ---------- prices ----------
    // the supplier's price for a line, or null when they keep the shop's
    function priceFor(item) {
        if (!has(draft.prices, item.id)) return null;
        const typed = parseFloat(draft.prices[item.id]);
        if (!Number.isFinite(typed)) return NaN;
        return Math.round(typed * 100) / 100;
    }

    function lineChanged(item) {
        const price = priceFor(item);
        return price !== null && !Number.isNaN(price) && price !== Number(item.unit_cost);
    }

    // the discount off the whole order in pesos, from what is typed; 0 when
    // nothing (or nothing usable) is typed -- discountProblem() says why
    function discountAmount(goods) {
        const value = parseFloat(draft.discount);
        if (!Number.isFinite(value) || value <= 0) return 0;
        const amount = draft.discountType === 'percent' ? goods * value / 100 : value;
        return Math.round(amount * 100) / 100;
    }

    function discountProblem() {
        if (String(draft.discount).trim() === '') return null;
        const value = parseFloat(draft.discount);
        if (!Number.isFinite(value) || value < 0) return 'The discount has to be zero or more.';
        if (draft.discountType === 'percent' && value >= 100) return 'A percentage has to be less than 100%.';
        let goods = 0;
        for (const item of view.items) {
            goods += lineChanged(item) ? priceFor(item) * Number(item.quantity) : Number(item.line_cost || 0);
        }
        if (discountAmount(goods) >= goods) return 'The discount has to be less than the order total.';
        return null;
    }

    function totals() {
        let ours = 0;
        let theirs = 0;
        let changed = 0;
        for (const item of view.items) {
            const line = Number(item.line_cost || 0);
            ours += line;
            if (lineChanged(item)) {
                theirs += priceFor(item) * Number(item.quantity);
                changed += 1;
            } else {
                theirs += line;
            }
        }
        const discount = discountProblem() ? 0 : discountAmount(theirs);
        return { ours: ours, theirs: theirs, changed: changed, discount: discount,
                 total: Math.round((theirs - discount) * 100) / 100 };
    }

    function deltaChip(from, to) {
        const difference = Math.round((to - from) * 100) / 100;
        if (difference === 0) return '';
        const up = difference > 0;
        const percent = from > 0 ? Math.round(Math.abs(difference) / from * 1000) / 10 : null;
        return '<span class="so-delta ' + (up ? 'is-up' : 'is-down') + '">' +
            (up ? '+' : '−') + peso(Math.abs(difference)) +
            (percent !== null ? ' · ' + percent + '%' : '') + '</span>';
    }

    // ---------- the page ----------
    function showProblem(title, text) {
        main.innerHTML = '<section class="so-panel so-closed"><i class="bi bi-link-45deg" aria-hidden="true"></i>' +
            '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(text) + '</p></section>';
    }

    function fillHeader() {
        const order = view.order;
        const shop = view.shop || {};
        document.getElementById('so-shop').textContent = shop.store_name || 'Lucelyn Hardware';
        document.getElementById('so-shop-line').textContent = shop.address || 'Purchase order for our supplier';
        document.getElementById('so-ref').textContent = order.number;
        document.title = order.number + ' · ' + (shop.store_name || 'Lucelyn Hardware');
    }

    // three stops: sent, the supplier's answer, the delivery
    function trackHtml(order) {
        let stage = 1;
        if (order.supplier_response === 'Accepted') stage = 2;
        if (order.status === 'Received') stage = 3;
        const stop = (index, label, sub) => {
            let state = '';
            if (index < stage) state = 'is-done';
            else if (index === stage) state = 'is-now';
            return '<li class="so-stop ' + state + '"><span class="so-dot">' +
                (index < stage ? '<i class="bi bi-check-lg" aria-hidden="true"></i>' : index + 1) +
                '</span><span class="so-stop-label">' + label + '</span>' +
                '<span class="so-stop-sub">' + escapeHtml(sub) + '</span></li>';
        };
        return '<ol class="so-track">' +
            stop(0, 'Order sent', String(order.order_date || '').slice(0, 10)) +
            stop(1, 'Your answer', order.supplier_response ? order.supplier_response : 'Now') +
            stop(2, 'Shipped', order.supplier_ship_date ? dayText(order.supplier_ship_date) : 'Next') +
            '</ol>';
    }

    function render(message) {
        fillHeader();
        if (view.order.can_respond) renderQuote();
        else renderReceipt(message);
    }

    // ---- open: read the order, answer it ----
    function renderQuote() {
        const order = view.order;
        const pdf = '/api/supplier-order/' + encodeURIComponent(code) + '/pdf';

        main.innerHTML =
            '<section class="so-hero">' + trackHtml(order) + '</section>' +

            // 1. the order, with a price button on every line
            '<section class="so-panel">' +
                '<header class="so-step"><span class="so-num">1</span><div><h2>Check the order</h2>' +
                    '<p>Price not what you sell it for? Press <strong>Edit price</strong> on that line.</p>' +
                '</div></header>' +
                '<ol class="so-lines" id="so-lines">' +
                    view.items.map((item, index) => lineHtml(item, index)).join('') +
                '</ol>' +
                // a discount off the whole order: a percentage or a peso amount
                '<div class="so-discount">' +
                    '<label class="so-label" for="so-discount">Discount <span>optional</span></label>' +
                    '<div class="so-discount-row">' +
                        '<span class="so-money so-discount-box">' +
                            '<span id="so-discount-sign" aria-hidden="true">₱</span>' +
                            '<input type="number" inputmode="decimal" min="0" step="0.01" id="so-discount" ' +
                                   'placeholder="0.00" value="' + escapeHtml(draft.discount) + '"></span>' +
                        '<div class="so-switch" role="radiogroup" aria-label="Discount as">' +
                            '<button type="button" data-discount-type="amount" role="radio">₱ Amount</button>' +
                            '<button type="button" data-discount-type="percent" role="radio">% Percent</button>' +
                        '</div>' +
                    '</div>' +
                    '<p class="so-field-error" id="so-discount-error"></p>' +
                '</div>' +
                '<div class="so-order-total" id="so-order-total"></div>' +
                '<a class="so-btn so-btn-quiet so-pdf" href="' + pdf + '" target="_blank" rel="noopener">' +
                    '<i class="bi bi-file-earmark-pdf" aria-hidden="true"></i>Open the printable order (PDF)</a>' +
            '</section>' +

            // 2. the decision, as two big buttons
            '<section class="so-panel">' +
                '<header class="so-step"><span class="so-num">2</span><div><h2>Your answer</h2>' +
                    '<p>Choose one.</p></div></header>' +
                '<div class="so-choices" role="radiogroup" aria-label="Your answer">' +
                    '<button type="button" class="so-choice is-accept" data-decision="accept" role="radio" aria-checked="false">' +
                        '<i class="bi bi-check-circle" aria-hidden="true"></i>' +
                        '<span class="so-choice-title">Accept order</span>' +
                        '<span class="so-choice-sub">We can fill it</span></button>' +
                    '<button type="button" class="so-choice is-decline" data-decision="decline" role="radio" aria-checked="false">' +
                        '<i class="bi bi-x-circle" aria-hidden="true"></i>' +
                        '<span class="so-choice-title">Decline order</span>' +
                        '<span class="so-choice-sub">We cannot fill it</span></button>' +
                '</div>' +
            '</section>' +

            // 3a. accepting: when it ships, and a note
            '<section class="so-panel" id="so-accept-part" hidden>' +
                '<header class="so-step"><span class="so-num">3</span><div><h2>When will it ship?</h2>' +
                    '<p>The day the goods leave you for our store.</p></div></header>' +
                '<label class="so-label" for="so-date">Ship date</label>' +
                '<span class="so-date-box">' +
                    '<input type="date" id="so-date" min="' + dayFromNow(1) + '" max="' + dayFromNow(365) + '"></span>' +
                '<p class="so-when" id="so-when"></p>' +
                '<label class="so-label" for="so-note">Remarks <span>optional</span></label>' +
                '<textarea id="so-note" class="so-input" maxlength="255" rows="2" ' +
                    'placeholder="Two sacks arrive a day after the rest">' + escapeHtml(draft.note) + '</textarea>' +
            '</section>' +

            // 3b. declining: why
            '<section class="so-panel" id="so-decline-part" hidden>' +
                '<header class="so-step"><span class="so-num">3</span><div><h2>Why can you not fill it?</h2>' +
                    '<p>Tell the shop why, so they can order elsewhere.</p></div></header>' +
                '<textarea id="so-why" class="so-input" maxlength="255" rows="2" ' +
                    'placeholder="The Boysen enamel is out of stock until next month">' +
                    escapeHtml(draft.reason) + '</textarea>' +
            '</section>' +

            // what will be sent, and the one button that sends it
            '<section class="so-send" id="so-send-part" hidden>' +
                '<div class="so-summary" id="so-summary"></div>' +
                '<p class="so-error" id="so-error" role="alert"></p>' +
                '<button type="button" class="so-btn so-btn-big" id="so-send"></button>' +
            '</section>';

        wireQuote();
        refreshAll();
    }

    function lineHtml(item, index) {
        const unit = item.unit_name || 'unit';
        return '<li class="so-line" data-id="' + item.id + '">' +
            '<div class="so-line-top">' +
                '<span class="so-line-no">' + (index + 1) + '</span>' +
                '<div class="so-line-what"><strong>' + escapeHtml(item.product_name) + '</strong>' +
                    '<span>' + escapeHtml(lineQuantity(item)) +
                    (item.brand_name ? ' · ' + escapeHtml(item.brand_name) : '') + '</span></div>' +
                '<div class="so-line-sum"><span class="so-fig" data-total></span><span data-delta></span></div>' +
            '</div>' +
            '<div class="so-line-bottom">' +
                '<span class="so-line-price" data-price-text></span>' +
                '<button type="button" class="so-btn so-btn-small" data-edit="' + item.id + '">' +
                    '<i class="bi bi-pencil" aria-hidden="true"></i>Edit price</button>' +
            '</div>' +
            '<div class="so-edit" data-editor>' +
                '<label class="so-label" for="so-price-' + item.id + '">Your price per ' + escapeHtml(unit) + '</label>' +
                '<div class="so-edit-row">' +
                    '<span class="so-money"><span aria-hidden="true">₱</span>' +
                        '<input type="number" inputmode="decimal" min="0.01" step="0.01" ' +
                               'id="so-price-' + item.id + '" data-price="' + item.id + '"></span>' +
                    '<button type="button" class="so-btn so-btn-small so-btn-save" data-save="' + item.id + '">' +
                        '<i class="bi bi-check-lg" aria-hidden="true"></i>Save</button>' +
                    '<button type="button" class="so-btn so-btn-small so-btn-quiet" data-cancel="' + item.id + '">' +
                        'Cancel</button>' +
                '</div>' +
                '<p class="so-field-error" data-line-error></p>' +
            '</div>' +
        '</li>';
    }

    // ---------- keeping the page in step with what is typed ----------
    function refreshAll() {
        refreshLines();
        refreshDiscount();
        refreshDecision();
        refreshWhen();
        refreshSummary();
    }

    function refreshLines() {
        document.querySelectorAll('.so-line').forEach((row) => {
            const item = view.items.find((each) => String(each.id) === row.dataset.id);
            if (!item) return;
            const editing = Boolean(draft.editing[item.id]);
            const price = priceFor(item);
            const changed = lineChanged(item);
            const unit = item.unit_name || 'unit';

            row.classList.toggle('is-editing', editing);
            row.classList.toggle('is-changed', changed);

            const ours = Number(item.line_cost || 0);
            const total = row.querySelector('[data-total]');
            const delta = row.querySelector('[data-delta]');
            if (changed) {
                const theirs = price * Number(item.quantity);
                total.innerHTML = '<s>' + peso(ours) + '</s> ' + peso(theirs);
                delta.innerHTML = deltaChip(ours, theirs);
            } else {
                total.textContent = peso(ours);
                delta.innerHTML = '';
            }

            row.querySelector('[data-price-text]').innerHTML = changed
                ? '<s>' + peso(item.unit_cost) + '</s> <strong>' + peso(price) + '</strong> per ' + escapeHtml(unit) +
                  ' <span class="so-yours">your price</span>'
                : peso(item.unit_cost) + ' per ' + escapeHtml(unit);

            row.querySelector('[data-edit]').hidden = editing;
        });
        refreshTotal();
    }

    function refreshTotal() {
        const box = document.getElementById('so-order-total');
        if (!box) return;
        const figures = totals();
        let html = '';
        if (figures.changed || figures.discount > 0) {
            html += '<div><span>Items</span><span class="so-fig">' +
                (figures.changed ? '<s>' + peso(figures.ours) + '</s> ' : '') + peso(figures.theirs) + '</span></div>';
        }
        if (figures.discount > 0) {
            html += '<div class="is-discount"><span>Discount' +
                (draft.discountType === 'percent' ? ' (' + escapeHtml(String(parseFloat(draft.discount))) + '%)' : '') +
                '</span><span class="so-fig">−' + peso(figures.discount) + '</span></div>';
        }
        html += '<div class="is-total"><span>Order total</span><span class="so-fig">' + peso(figures.total) + '</span>' +
            (figures.total !== figures.ours ? deltaChip(figures.ours, figures.total) : '') + '</div>';
        box.innerHTML = html;
    }

    function refreshDiscount() {
        document.querySelectorAll('[data-discount-type]').forEach((button) => {
            const on = button.dataset.discountType === draft.discountType;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        const sign = document.getElementById('so-discount-sign');
        if (sign) sign.textContent = draft.discountType === 'percent' ? '%' : '₱';
        const error = document.getElementById('so-discount-error');
        if (error) error.textContent = discountProblem() || '';
        document.querySelector('.so-discount-box').classList.toggle('is-bad', Boolean(discountProblem()));
    }

    function refreshDecision() {
        document.querySelectorAll('[data-decision]').forEach((button) => {
            const on = button.dataset.decision === draft.decision;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        document.getElementById('so-accept-part').hidden = draft.decision !== 'accept';
        document.getElementById('so-decline-part').hidden = draft.decision !== 'decline';
        document.getElementById('so-send-part').hidden = draft.decision === '';

        const send = document.getElementById('so-send');
        send.className = 'so-btn so-btn-big ' + (draft.decision === 'decline' ? 'is-decline' : 'is-accept');
        send.innerHTML = draft.decision === 'decline'
            ? '<i class="bi bi-send" aria-hidden="true"></i>Send: decline the order'
            : '<i class="bi bi-send" aria-hidden="true"></i>Send: accept the order';
    }

    // only a day after today: the calendar does not offer an earlier one, and
    // a day typed in by hand is checked here as well
    function dateProblem() {
        if (!draft.shipDate) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.shipDate)) return 'That is not a date.';
        if (draft.shipDate <= dayFromNow(0)) return 'Pick a day after today. The ship date cannot be today or in the past.';
        if (draft.shipDate > dayFromNow(365)) return 'Pick a day within the next year.';
        return null;
    }

    function refreshWhen() {
        const box = document.getElementById('so-when');
        const picker = document.getElementById('so-date');
        if (picker && picker.value !== draft.shipDate) picker.value = draft.shipDate;
        if (!box) return;

        const problem = dateProblem();
        document.querySelector('.so-date-box').classList.toggle('is-bad', Boolean(problem));
        if (problem) {
            box.className = 'so-when is-bad';
            box.textContent = problem;
            return;
        }
        if (!draft.shipDate) {
            box.className = 'so-when';
            box.textContent = 'No date picked yet.';
            return;
        }
        box.className = 'so-when is-set';
        // the words in one span, so the box's gap sits after the icon only
        box.innerHTML = '<i class="bi bi-truck" aria-hidden="true"></i><span>Ships <strong>' +
            escapeHtml(dayText(draft.shipDate, true)) + '</strong>, ' + escapeHtml(daysAway(draft.shipDate)) + '</span>';
    }

    // what will be sent, written out above the Send button
    function refreshSummary() {
        const box = document.getElementById('so-summary');
        if (!box || !draft.decision) return;

        if (draft.decision === 'decline') {
            const dropped = Object.keys(draft.prices).length > 0 || discountAmount(totals().theirs) > 0;
            box.innerHTML = '<p class="so-summary-head is-decline"><i class="bi bi-x-circle" aria-hidden="true"></i>' +
                'You are declining ' + escapeHtml(view.order.number) + '</p>' +
                (dropped ? '<p class="so-summary-line">Price changes and discounts are not sent when you decline.</p>' : '');
            return;
        }

        const figures = totals();
        const rows = [];
        rows.push('<li><span>Ships</span><strong>' +
            (draft.shipDate && !dateProblem() ? escapeHtml(dayText(draft.shipDate, true)) : '<em>pick a date above</em>') +
            '</strong></li>');
        rows.push('<li><span>Prices</span><strong>' +
            (figures.changed ? figures.changed + ' changed' : 'as ordered') + '</strong></li>');
        if (figures.discount > 0) {
            rows.push('<li><span>Discount</span><strong class="so-fig">−' + peso(figures.discount) + '</strong></li>');
        }
        rows.push('<li><span>Total</span><strong class="so-fig">' + peso(figures.total) + '</strong></li>');
        box.innerHTML = '<p class="so-summary-head"><i class="bi bi-check-circle" aria-hidden="true"></i>' +
            'You are accepting ' + escapeHtml(view.order.number) + '</p><ul class="so-summary-list">' +
            rows.join('') + '</ul>';
    }

    function setError(text) {
        const box = document.getElementById('so-error');
        if (box) box.textContent = text || '';
    }

    function lineError(id, text) {
        const row = document.querySelector('.so-line[data-id="' + id + '"]');
        if (!row) return;
        row.querySelector('[data-line-error]').textContent = text || '';
        row.querySelector('.so-money').classList.toggle('is-bad', Boolean(text));
    }

    // Save keeps the typed price; the same as ours keeps ours
    function savePrice(id) {
        const item = view.items.find((each) => String(each.id) === String(id));
        const input = document.getElementById('so-price-' + id);
        const typed = Math.round(parseFloat(input.value) * 100) / 100;
        if (!Number.isFinite(typed) || typed <= 0) {
            lineError(id, 'Type a price above zero, or press Cancel.');
            input.focus();
            return;
        }
        if (typed === Number(item.unit_cost)) delete draft.prices[id];
        else draft.prices[id] = String(typed);
        delete draft.editing[id];
        lineError(id, '');
        setError('');
        refreshLines();
        refreshDiscount();
        refreshSummary();
    }

    function wireQuote() {
        const lines = document.getElementById('so-lines');

        lines.addEventListener('click', (event) => {
            const edit = event.target.closest('[data-edit]');
            const save = event.target.closest('[data-save]');
            const cancel = event.target.closest('[data-cancel]');
            if (edit) {
                const id = edit.dataset.edit;
                const item = view.items.find((each) => String(each.id) === id);
                const input = document.getElementById('so-price-' + id);
                // opens on the price in force: theirs if saved before, else ours
                input.value = has(draft.prices, id) ? Number(draft.prices[id]).toFixed(2) : Number(item.unit_cost).toFixed(2);
                draft.editing[id] = true;
                lineError(id, '');
                refreshLines();
                setTimeout(() => { input.focus(); input.select(); }, 30);
            } else if (save) {
                savePrice(save.dataset.save);
            } else if (cancel) {
                delete draft.editing[cancel.dataset.cancel];
                lineError(cancel.dataset.cancel, '');
                setError('');
                refreshLines();
            }
        });

        // Enter in a price box saves it; Escape cancels
        lines.addEventListener('keydown', (event) => {
            const input = event.target.closest('[data-price]');
            if (!input) return;
            if (event.key === 'Enter') { event.preventDefault(); savePrice(input.dataset.price); }
            if (event.key === 'Escape') {
                delete draft.editing[input.dataset.price];
                lineError(input.dataset.price, '');
                refreshLines();
            }
        });

        const discount = document.getElementById('so-discount');
        discount.addEventListener('input', () => {
            draft.discount = discount.value;
            setError('');
            refreshDiscount();
            refreshTotal();
            refreshSummary();
        });
        document.querySelectorAll('[data-discount-type]').forEach((button) => {
            button.addEventListener('click', () => {
                draft.discountType = button.dataset.discountType;
                refreshDiscount();
                refreshTotal();
                refreshSummary();
                discount.focus();
            });
        });

        document.querySelectorAll('[data-decision]').forEach((button) => {
            button.addEventListener('click', () => {
                draft.decision = button.dataset.decision;
                setError('');
                refreshDecision();
                refreshSummary();
                const part = document.getElementById(draft.decision === 'accept' ? 'so-accept-part' : 'so-decline-part');
                part.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });

        const picker = document.getElementById('so-date');
        const pickDate = () => {
            draft.shipDate = picker.value;
            setError('');
            refreshWhen();
            refreshSummary();
        };
        picker.addEventListener('change', pickDate);
        picker.addEventListener('input', pickDate);

        document.getElementById('so-note').addEventListener('input', (event) => {
            draft.note = event.target.value;
        });

        const why = document.getElementById('so-why');
        why.addEventListener('input', () => { draft.reason = why.value; setError(''); });

        document.getElementById('so-send').addEventListener('click', send);
    }

    // ---------- sending ----------
    function problemWithDraft() {
        if (draft.decision === 'decline') {
            if (draft.reason.trim().length < 5) return { text: 'Type why you cannot fill the order.', focus: 'so-why' };
            return null;
        }
        const open = Object.keys(draft.editing)[0];
        if (open) {
            return { text: 'Press Save or Cancel on the price you are editing.', focus: 'so-price-' + open };
        }
        if (discountProblem()) return { text: discountProblem(), focus: 'so-discount' };
        if (!draft.shipDate) return { text: 'Pick the ship date.', focus: 'so-date' };
        if (dateProblem()) return { text: dateProblem(), focus: 'so-date' };
        return null;
    }

    function send() {
        const problem = problemWithDraft();
        if (problem) {
            setError(problem.text);
            const target = document.getElementById(problem.focus);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (target.focus) target.focus({ preventScroll: true });
            }
            return;
        }
        setError('');

        if (draft.decision === 'decline') {
            answer({ accept: false, note: draft.reason.trim() });
        } else {
            const prices = view.items.filter(lineChanged).map((item) => ({ id: item.id, unitCost: priceFor(item) }));
            const discount = String(draft.discount).trim() === ''
                ? null : { type: draft.discountType, value: Number(draft.discount) };
            answer({ accept: true, shipDate: draft.shipDate, prices: prices, discount: discount,
                     note: draft.note.trim() });
        }
    }

    async function answer(payload) {
        const button = document.getElementById('so-send');
        button.disabled = true;
        button.innerHTML = 'Sending&hellip;';

        try {
            const response = await fetch('/api/supplier-order/' + encodeURIComponent(code) + '/respond', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                if (result.view) {
                    view = result.view;
                    render();
                    showBanner(result.error || '', 'is-stop');
                    return;
                }
                setError(result.error || 'Your answer could not be saved. Try again in a moment.');
                button.disabled = false;
                refreshDecision();
                return;
            }

            view = result.view;
            render(result.message);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (problem) {
            setError('The shop could not be reached. Check your connection and try again.');
            button.disabled = false;
            refreshDecision();
        }
    }

    function showBanner(text, tone) {
        if (!text) return;
        main.insertAdjacentHTML('afterbegin',
            '<p class="so-flash ' + (tone || '') + '">' + escapeHtml(text) + '</p>');
    }

    // ---- answered, or closed: the receipt of what was said ----
    function renderReceipt(message) {
        const order = view.order;
        let mark = 'bi-check-lg';
        let tone = 'is-ok';
        let title = 'Order accepted';
        let sub = 'You answered on ' + stampText(order.supplier_responded_at) + '.';

        if (order.supplier_response === 'Declined') {
            mark = 'bi-x-lg';
            tone = 'is-stop';
            title = 'Order declined';
        } else if (!order.supplier_response) {
            mark = 'bi-lock';
            tone = 'is-closed';
            title = 'Nothing to answer';
            sub = order.status === 'Received' ? 'This order has been delivered and counted in.'
                : order.status === 'Cancelled' ? 'The shop cancelled this order.'
                : 'This order is not open for an answer.';
        }

        let total = 0;
        let ours = 0;
        const rows = view.items.map((item) => {
            total += Number(item.line_cost || 0);
            const original = item.original_unit_cost !== null && item.original_unit_cost !== undefined
                ? Number(item.original_unit_cost) : null;
            ours += original !== null ? original * Number(item.quantity) : Number(item.line_cost || 0);
            const moved = original !== null && original !== Number(item.unit_cost);
            return '<li class="so-rline' + (moved ? ' is-changed' : '') + '">' +
                '<span class="so-rname">' + escapeHtml(item.product_name) +
                    '<small>' + escapeHtml(lineQuantity(item)) + '</small></span>' +
                '<span class="so-rprice">' + (moved ? '<s>' + peso(original) + '</s>' : '') +
                    peso(item.unit_cost) + '<small>per ' + escapeHtml(item.unit_name || 'unit') + '</small></span>' +
                '<span class="so-fig">' + peso(item.line_cost) + '</span>' +
            '</li>';
        }).join('');

        const facts = [];
        if (order.supplier_ship_date) {
            facts.push('<div><span class="so-tag">Ships</span><strong>' +
                escapeHtml(dayText(order.supplier_ship_date, true)) + '</strong></div>');
        }
        const discount = Number(order.discount) || 0;
        if (discount > 0) {
            facts.push('<div><span class="so-tag">Discount</span><strong class="so-fig">−' + peso(discount) +
                '</strong></div>');
        }
        facts.push('<div><span class="so-tag">Total</span><strong class="so-fig">' + peso(total - discount) + '</strong>' +
            (Math.abs(total - discount - ours) >= 0.005 ? deltaChip(ours, total - discount) : '') + '</div>');
        if (order.supplier_note) {
            facts.push('<div class="so-wide"><span class="so-tag">' +
                (order.supplier_response === 'Declined' ? 'Reason' : 'Remarks') + '</span><span>' +
                escapeHtml(order.supplier_note) + '</span></div>');
        }

        main.innerHTML =
            (message ? '<p class="so-flash is-ok">' + escapeHtml(message) + '</p>' : '') +
            '<section class="so-receipt ' + tone + '">' +
                '<div class="so-seal"><i class="bi ' + mark + '" aria-hidden="true"></i></div>' +
                '<h1>' + title + '</h1>' +
                '<p class="so-lede">' + escapeHtml(sub) + '</p>' +
                trackHtml(order) +
                '<div class="so-rfacts">' + facts.join('') + '</div>' +
                '<ol class="so-rlines">' + rows + '</ol>' +
                (order.supplier_response === 'Accepted'
                    ? '<p class="so-quote">Quote <strong>' + escapeHtml(order.number) +
                        '</strong> on the delivery receipt and the invoice. To change anything, contact the shop.</p>'
                    : '') +
                '<a class="so-btn so-btn-quiet so-pdf" href="/api/supplier-order/' + encodeURIComponent(code) + '/pdf" ' +
                    'target="_blank" rel="noopener"><i class="bi bi-file-earmark-pdf" aria-hidden="true"></i>' +
                    'Open the printable order (PDF)</a>' +
            '</section>';
    }

    async function load() {
        // the code is 43 url-safe characters; anything else was cut or mistyped
        if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
            showProblem('This link is not complete',
                'Scan the QR code on the purchase order again, or contact the shop.');
            return;
        }

        try {
            const response = await fetch('/api/supplier-order/' + encodeURIComponent(code));
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                showProblem('This order cannot be opened', result.error || 'Contact the shop.');
                return;
            }
            view = result;
            render();
        } catch (problem) {
            showProblem('The shop could not be reached', 'Check your connection and open the link again.');
        }
    }

    load();
})();
