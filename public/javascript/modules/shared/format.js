// format.js  --  FORMATTING AND FETCHING
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
function peso(value) {
    const number = Number(value || 0);
    return number.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// ==========================================
// A WRITE, AND WHAT COMES BACK FROM IT
//
// The same shape as getJson for the other direction. It returns the body on
// success and null when the server refused, having already put the server's
// own sentence on the screen -- so a caller reads:
//
//     const result = await postJson(url, data);
//     if (!result) return;
//
// and never has to decide how to word a refusal it does not understand. A
// server that cannot be reached at all throws, because that is not a refusal
// and the caller's catch is where notifyOffline() belongs.
//
// It returns null rather than throwing on a refusal on purpose: a refused
// request is an ordinary outcome of a form, and a flow made of several
// requests would otherwise have to tell a refusal apart from a dropped
// connection inside one catch block.
// ==========================================
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

// The bell needs this and so does a popup card, and a popup card can appear
// on the sign-in screen where the bell does not exist, so it lives here with
// the rest of the formatting rather than with the alerts.
// "4 Sep 2026, 16:45" plus how long ago that was, because a date alone does
// not tell you whether this is today's problem or last month's
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

// ==========================================
// PHILIPPINE PHONE NUMBERS
//
// One spelling of a number, and it is +63 followed by ten digits.
//
// The box these functions sit behind used to be a plain text field, so it
// took anything: letters, spaces, brackets, "n/a", and the same number
// written as 09171234567, +639171234567, 639171234567 and 0917 123 4567 by
// four different people on four different afternoons. Four spellings of one
// number is a column that cannot be searched, cannot be compared, and cannot
// be dialled from without being read by a human first.
//
// So the country code is not typed at all -- it is printed beside the box as
// fixed furniture -- and what is typed is the ten national digits, with
// everything that is not a digit dropped as the keys are pressed rather than
// complained about afterwards. A rule that refuses a keystroke teaches the
// rule in the moment; a rule that refuses the form at the end teaches
// nothing and loses the other nine fields.
//
// The stored form is +639171234567. The server is the one that decides that,
// not this file: these functions are the box's manners, and the same rule is
// enforced again in server.js, because a check that only exists in a browser
// is a check anybody can skip with curl.
// ==========================================

// Ten digits, and the first is 9. Philippine mobile numbers are 09XXXXXXXXX
// nationally, which is +63 9XXXXXXXXX with the trunk 0 dropped -- the 0 and
// the +63 are the same thing and never both appear.
const PHONE_NATIONAL_DIGITS = 10;

// Everything that is not a digit, gone. Leading zeros go too: somebody typing
// the number as they know it, 0917..., means +63 917..., and a stored
// +630917... is a number that does not dial.
function phoneDigits(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\D/g, '')
        .replace(/^63/, '')          // pasted with the country code in it
        .replace(/^0+/, '')          // typed with the national trunk zero
        .slice(0, PHONE_NATIONAL_DIGITS);
}

// Wired to oninput on every phone box in the system. It rewrites the box
// rather than blocking the key, which is what makes a pasted number work as
// well as a typed one.
function onPhoneInput(input) {
    if (!input) return;

    const cleaned = phoneDigits(input.value);
    if (cleaned !== input.value) {
        // putting the caret back at the end is right here: the only edit this
        // makes is removing characters that were never valid
        input.value = cleaned;
    }

    // The box says whether it is happy as it is being filled in, and says
    // nothing at all while it is empty, because the number is optional and an
    // empty optional box is not a mistake.
    input.classList.toggle('is-bad',
        cleaned !== '' && phoneComplaint(cleaned) !== null);
}

// The one sentence said about a bad number, or null when there is nothing to
// say. Returned rather than shown, so the caller decides where it goes.
function phoneComplaint(value) {
    const digits = phoneDigits(value);

    if (digits === '') return null;                 // optional, and left empty
    if (digits.length !== PHONE_NATIONAL_DIGITS) {
        return `A phone number is ${PHONE_NATIONAL_DIGITS} digits after +63. ` +
               `That one has ${digits.length}.`;
    }
    if (digits[0] !== '9') {
        return 'After +63 a Philippine mobile number starts with 9.';
    }
    return null;
}

// what goes to the server, and what is stored: +639171234567, or nothing
function phoneToStore(value) {
    const digits = phoneDigits(value);
    return digits === '' ? '' : '+63' + digits;
}

// the ten digits out of a stored number, to put back into the box beside the
// printed +63. A number stored before this rule existed still loads: the
// digits are pulled out of whatever spelling it was saved in.
function phoneToInput(stored) {
    return phoneDigits(stored);
}

// how a stored number reads on a record card: +63 917 123 4567
function phoneForDisplay(stored) {
    const digits = phoneDigits(stored);
    if (digits === '') return '';
    if (digits.length !== PHONE_NATIONAL_DIGITS) return '+63' + digits;

    return `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}
