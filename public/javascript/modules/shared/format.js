// format.js -- formatting and fetching
// Loaded by: all five dashboards
// Money is always printed with the peso sign as a text prefix; sheetCell in
// manager.js strips it again for the spreadsheet export.
const CURRENCY_SIGN = '\u20B1';       // the peso sign

function peso(value) {
    const number = Number(value || 0);
    const text = Math.abs(number).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (number < 0 ? '-' : '') + CURRENCY_SIGN + text;
}

// Measured units (kg, m) accept decimals and step by a half; anything not
// listed here is counted and steps by one.
const MEASURED_UNITS = {
    kilogram: { short: 'kg', step: 0.5 },
    kg:       { short: 'kg', step: 0.5 },
    gram:     { short: 'g',  step: 50 },
    meter:    { short: 'm',  step: 0.5 },
    metre:    { short: 'm',  step: 0.5 },
    liter:    { short: 'L',  step: 0.5 },
    litre:    { short: 'L',  step: 0.5 },
    foot:     { short: 'ft', step: 0.5 },
    gallon:   { short: 'gal', step: 0.5 }
};

function measuredUnit(unit) {
    return MEASURED_UNITS[String(unit || '').trim().toLowerCase()] || null;
}

function isMeasuredUnit(unit) {
    return measuredUnit(unit) !== null;
}

function qtyText(value, unit) {
    const number = Number(value) || 0;
    const measure = measuredUnit(unit);
    const figure = Number.isInteger(number) ? String(number)
        : String(Number(number.toFixed(3))).replace(/\.?0+$/, '');
    const name = measure ? measure.short : String(unit || '').trim();
    return name ? figure + ' ' + name : figure;
}

function statusBadge(text) {
    const good = ['Paid', 'Delivered', 'In Stock', 'Active', 'Received'];
    const bad = ['Unpaid', 'Failed', 'Out of Stock', 'Inactive', 'Cancelled'];
    const warn = ['Partial', 'Low Stock', 'Delayed', 'Pending', 'In Transit', 'Out for Delivery'];

    let tone = 'badge-neutral';
    if (good.indexOf(text) !== -1) tone = 'badge-success';
    else if (bad.indexOf(text) !== -1) tone = 'badge-danger';
    else if (warn.indexOf(text) !== -1) tone = 'badge-warning';

    return '<span class="badge ' + tone + '">' + escapeHtml(text) + '</span>';
}

function tableMessage(tableId, columns, text) {
    const tbody = document.querySelector('#' + tableId + ' tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + columns + '" class="table-empty">' + text + '</td></tr>';
}

function setPill(id, text) {
    const pill = document.getElementById(id);
    if (pill) pill.textContent = text;
}

async function getJson(url) {
    const response = await fetch(url, { headers: apiHeaders() });
    if (!response.ok) {
        let body = null;
        try { body = await response.json(); } catch (error) { body = null; }
        handleAuthFailure(response, body);
        throw new Error('request failed');
    }
    return response.json();
}

// Returns the body on success and null on a refusal (the server's own
// sentence is already on screen). Throws only when the server is unreachable,
// so the caller's catch is where notifyOffline() belongs.
async function postJson(url, data, method) {
    const response = await fetch(url, {
        method: method || 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(data === undefined ? {} : data)
    });

    let body = null;
    try { body = await response.json(); } catch (error) { body = null; }

    if (!response.ok) {
        if (!handleAuthFailure(response, body)) {
            notifyError((body && body.error) || 'That did not work.');
        }
        return null;
    }

    return body || {};
}

// "4 Sep 2026, 16:45" plus how long ago that was
function whenText(stamp) {
    if (!stamp) return 'Time not recorded';

    const when = new Date(String(stamp).replace(' ', 'T'));
    if (isNaN(when.getTime())) return String(stamp).slice(0, 16);

    const shown = when.toLocaleString('en-PH', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    });

    const minutes = Math.round((Date.now() - when.getTime()) / 60000);
    if (minutes < 1) return shown + ' · just now';
    if (minutes < 60) return shown + ' · ' + minutes + ' min ago';

    const hours = Math.round(minutes / 60);
    if (hours < 24) return shown + ' · ' + hours + (hours === 1 ? ' hour ago' : ' hours ago');

    const days = Math.round(hours / 24);
    if (days < 31) return shown + ' · ' + days + (days === 1 ? ' day ago' : ' days ago');

    return shown;
}

// Phone numbers are stored as + country code + digits (+639171234567). The
// box is a country button (phone-picker.js) beside a digits-only field; a
// number pasted with its + is read for its country. Under +63 a number must
// be ten digits starting with 9; under any other code only length is checked.
// The same rule is enforced again in server.js.

// E.164 limits
const PHONE_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 7;

const PH_CODE = '63';
const PH_NATIONAL_DIGITS = 10;

// every digit as one string: a trunk 0 becomes 63, a 0 after +63 goes
function phoneDigitsAll(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\D/g, '')
        .replace(/^0+/, PH_CODE)                       // 0917... is +63 917...
        .replace(new RegExp('^' + PH_CODE + '0+'), PH_CODE);   // +63 0917... too
}

function phoneDigits(value) {
    return phoneDigitsAll(value).slice(0, PHONE_MAX_DIGITS);
}

// Takes a phone box or a string; returns every digit with the code in front,
// and the code on its own.
function phoneParts(boxOrValue) {
    const isBox = !!(boxOrValue && boxOrValue.nodeType === 1);
    if (isBox && boxOrValue.dataset.dialCode) {
        const code = boxOrValue.dataset.dialCode;
        const national = phoneNationalDigits(boxOrValue.value, boxOrValue.dataset.country);
        return { code, digits: national === '' ? '' : code + national };
    }
    const digits = phoneDigitsAll(isBox ? boxOrValue.value : boxOrValue);
    const country = typeof phoneCountryForDigits === 'function' ? phoneCountryForDigits(digits) : null;
    return { code: country ? country.code : (digits.indexOf(PH_CODE) === 0 ? PH_CODE : ''), digits };
}

// digits inside a country: no trunk 0, unless the country keeps it
function phoneNationalDigits(value, iso) {
    const keepsZero = typeof PHONE_KEEPS_TRUNK_ZERO !== 'undefined' && PHONE_KEEPS_TRUNK_ZERO.indexOf(iso) !== -1;
    let digits = String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
    if (!keepsZero) digits = digits.replace(/^0+/, '');
    return digits;
}

// oninput on every phone box; rewrites rather than blocks so paste works too
function onPhoneInput(input) {
    if (!input) return;
    if (typeof setupPhoneField === 'function') setupPhoneField(input);

    const raw = String(input.value);
    const withCode = /^\s*(\+|00)\s*\d/.test(raw);

    if (withCode && typeof phoneCountryForDigits === 'function') {
        const digits = raw.replace(/^\s*(\+|00)/, '').replace(/\D/g, '');
        const country = phoneCountryForDigits(digits);
        if (country) {
            setPhoneCountry(input, country.iso);
            input.value = digits.slice(country.code.length);
        } else {
            input.value = digits;
        }
        input.dataset.foreign = country ? '' : '1';
    } else {
        input.dataset.foreign = '';
    }

    const room = PHONE_MAX_DIGITS - String(input.dataset.dialCode || '').length;
    const cleaned = phoneNationalDigits(input.value, input.dataset.country).slice(0, room);
    if (cleaned !== input.value) {
        input.value = cleaned;
    }

    input.classList.toggle('is-bad',
        cleaned !== '' && phoneComplaint(input) !== null);
}

// The sentence said about a bad number, or null. Returned, not shown.
function phoneComplaint(boxOrValue) {
    if (boxOrValue && boxOrValue.nodeType === 1 && boxOrValue.dataset.foreign === '1' &&
        String(boxOrValue.value).trim() !== '') {
        return 'Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.';
    }

    const parts = phoneParts(boxOrValue);
    const code = parts.code;
    const digits = parts.digits;

    if (digits === '') return null;                 // optional, and left empty

    if (code !== PH_CODE) {
        return 'Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.';
    }

    const national = digits.slice(PH_CODE.length);
    if (national.length !== PH_NATIONAL_DIGITS) {
        return 'A Philippine mobile number is ' + PH_NATIONAL_DIGITS + ' digits after +63 ' +
               '(09XX XXX XXXX). That one has ' + national.length + '.';
    }
    if (national[0] !== '9') {
        return 'A Philippine mobile number starts with 09 (or +63 9).';
    }
    return null;
}

// what goes to the server: +639171234567, or nothing
function phoneToStore(boxOrValue) {
    const digits = phoneParts(boxOrValue).digits.slice(0, PHONE_MAX_DIGITS);
    return digits === '' ? '' : '+' + digits;
}

// a stored number put back into a box; older spellings still load
function phoneFill(input, stored) {
    if (!input) return;
    if (typeof setupPhoneField === 'function') setupPhoneField(input);

    const digits = phoneDigits(stored);
    const country = digits !== '' && typeof phoneCountryForDigits === 'function'
        ? phoneCountryForDigits(digits) : null;

    if (typeof setPhoneCountry === 'function') {
        setPhoneCountry(input, country ? country.iso : PHONE_DEFAULT_COUNTRY);
    }
    input.value = country ? digits.slice(country.code.length) : digits;
    input.classList.remove('is-bad');
}

function phoneToInput(stored) {
    return phoneDigits(stored);
}

// +63 917 123 4567 for Philippine mobiles; any other number as stored
function phoneForDisplay(stored) {
    const digits = phoneDigits(stored);
    if (digits === '') return '';

    const national = digits.slice(PH_CODE.length);
    if (digits.indexOf(PH_CODE) === 0 && national.length === PH_NATIONAL_DIGITS) {
        return '+63 ' + national.slice(0, 3) + ' ' + national.slice(3, 6) + ' ' + national.slice(6);
    }
    return '+' + digits;
}
