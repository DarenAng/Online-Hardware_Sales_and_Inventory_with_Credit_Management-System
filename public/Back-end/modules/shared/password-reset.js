// password-reset.js -- "Forgot your password?" on the sign-in page
// Loaded by: Login.html
//
// Two steps on a second card: the address the code goes to, then the code
// from the mail with the new password. The server answers the first step the
// same way whether or not the address has an account, so this screen never
// says which it was either. Nothing here signs anybody in: once the password
// is saved the person is sent back to the sign-in card to use it.

// the address the code was sent to, kept for the second step
let resetEmail = '';

function resetCard(name) {
    const signIn = document.getElementById('sign-in-card');
    const reset = document.getElementById('reset-card');
    if (signIn) signIn.hidden = name !== 'sign-in';
    if (reset) reset.hidden = name !== 'reset';
}

function showResetAlert(message, tone) {
    const box = document.getElementById('reset-alert');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('is-good', tone === 'good');
    box.hidden = !message;
}

// from the link under the sign-in form; the address already typed there is carried over
function openPasswordReset() {
    const typed = document.getElementById('login-email');
    const box = document.getElementById('reset-email');
    if (box && typed && typed.value.trim() !== '') box.value = typed.value.trim();

    showResetRequest();
    resetCard('reset');
    if (box) box.focus();
}

function closePasswordReset() {
    resetCard('sign-in');
    const email = document.getElementById('login-email');
    if (email) email.focus();
}

// step 1 again, for a code that did not arrive or ran out
function showResetRequest() {
    const request = document.getElementById('reset-request-form');
    const confirm = document.getElementById('reset-confirm-form');
    const again = document.getElementById('reset-again-link');
    const lead = document.getElementById('reset-lead');

    if (request) request.hidden = false;
    if (confirm) { confirm.hidden = true; confirm.reset(); }
    if (again) again.hidden = true;
    if (lead) {
        lead.textContent = 'Type the email address you sign in with. A six-digit code is sent to it; ' +
            'the code and a new password are all this takes.';
    }
    showResetAlert('');
}

function setBusy(buttonId, busy, idleText, busyText) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? busyText : idleText;
}

async function handleResetRequest(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const email = form.elements.email.value.trim();

    if (email === '') {
        showResetAlert('Type the email address you sign in with.');
        form.elements.email.focus();
        return;
    }

    setBusy('reset-request-btn', true, 'Send Code', 'Sending...');

    try {
        const response = await apiRequestResetCode(email);
        const result = await response.json();

        if (!response.ok) {
            // mail not set up is said in full, with who can help instead
            showResetAlert(result.error || 'The code could not be sent.');
            return;
        }

        resetEmail = email;

        const request = document.getElementById('reset-request-form');
        const confirm = document.getElementById('reset-confirm-form');
        const again = document.getElementById('reset-again-link');
        const lead = document.getElementById('reset-lead');

        if (request) request.hidden = true;
        if (confirm) confirm.hidden = false;
        if (again) again.hidden = false;
        if (lead) {
            lead.textContent = 'Look in the mailbox for ' + email + ' (and its spam folder). ' +
                'Type the code from the mail, then the password you want.';
        }
        showResetAlert(result.message, 'good');

        const code = document.getElementById('reset-code');
        if (code) code.focus();
    } catch (error) {
        showResetAlert('The server is not answering. Start it with npm start in the project folder, then try again.');
    } finally {
        setBusy('reset-request-btn', false, 'Send Code', 'Sending...');
    }
}

async function handleResetConfirm(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const code = form.elements.code.value.replace(/\s+/g, '');
    const newPassword = form.elements.newPassword.value;
    const confirmPassword = form.elements.confirmPassword.value;

    if (!/^\d{6}$/.test(code)) {
        showResetAlert('The code is the six digits in the email.');
        form.elements.code.focus();
        return;
    }
    if (newPassword.length < 8) {
        showResetAlert('A password needs at least 8 characters.');
        form.elements.newPassword.focus();
        return;
    }
    if (newPassword !== confirmPassword) {
        showResetAlert('The two passwords do not match. Type the same one in both boxes.');
        form.elements.confirmPassword.value = '';
        form.elements.confirmPassword.focus();
        return;
    }

    setBusy('reset-confirm-btn', true, 'Save the new password', 'Saving...');

    try {
        const response = await apiConfirmResetCode(resetEmail, code, newPassword);
        const result = await response.json();

        if (!response.ok) {
            showResetAlert(result.error || 'The password was not changed.');
            form.elements.code.value = '';
            form.elements.code.focus();
            return;
        }

        // back to the sign-in card, with the address filled in and the news beside it
        form.reset();
        const email = document.getElementById('login-email');
        if (email) email.value = resetEmail;
        resetCard('sign-in');
        showLoginAlert(result.message || 'Your password was changed. Sign in with the new one.', 'good');

        const password = document.getElementById('login-password');
        if (password) password.focus();
    } catch (error) {
        showResetAlert('The server is not answering. Start it with npm start in the project folder, then try again.');
    } finally {
        setBusy('reset-confirm-btn', false, 'Save the new password', 'Saving...');
    }
}
