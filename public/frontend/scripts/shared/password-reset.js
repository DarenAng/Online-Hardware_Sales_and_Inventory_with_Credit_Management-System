let resetEmail = '';
let resetCode = '';

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

function showResetStep(step) {
    const request = document.getElementById('reset-request-form');
    const code = document.getElementById('reset-code-form');
    const confirm = document.getElementById('reset-confirm-form');
    const again = document.getElementById('reset-again-link');

    if (request) request.hidden = step !== 'request';
    if (code) code.hidden = step !== 'code';
    if (confirm) confirm.hidden = step !== 'password';
    if (again) again.hidden = step === 'request';
}

function setResetLead(text) {
    const lead = document.getElementById('reset-lead');
    if (lead) lead.textContent = text;
}

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

function showResetRequest() {
    const code = document.getElementById('reset-code-form');
    const confirm = document.getElementById('reset-confirm-form');
    if (code) code.reset();
    if (confirm) confirm.reset();
    resetCode = '';

    showResetStep('request');
    setResetLead('Type the email address you sign in with. A six-digit code is sent to it; ' +
        'the code and a new password are all this takes.');
    showResetAlert('');
}

function showResetCodeStep() {
    resetCode = '';
    showResetStep('code');
    setResetLead('Look in the mailbox for ' + resetEmail + ' (and its spam folder). ' +
        'Type the code from the mail, then press Verify Code.');

    const code = document.getElementById('reset-code');
    if (code) {
        code.value = '';
        code.focus();
    }
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
            showResetAlert(result.error || 'The code could not be sent.');
            return;
        }

        resetEmail = email;
        showResetCodeStep();
        showResetAlert(result.message, 'good');
    } catch (error) {
        showResetAlert('The server is not answering. Start it with npm start in the project folder, then try again.');
    } finally {
        setBusy('reset-request-btn', false, 'Send Code', 'Sending...');
    }
}

async function handleResetVerify(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const code = form.elements.code.value.replace(/\s+/g, '');

    if (!/^\d{6}$/.test(code)) {
        showResetAlert('The code is the six digits in the email.');
        form.elements.code.focus();
        return;
    }

    setBusy('reset-verify-btn', true, 'Verify Code', 'Checking...');

    try {
        const response = await apiVerifyResetCode(resetEmail, code);
        const result = await response.json();

        if (!response.ok) {
            showResetAlert(result.error || 'That code was not accepted.');
            form.elements.code.value = '';
            form.elements.code.focus();
            return;
        }

        resetCode = code;
        showResetStep('password');
        setResetLead('Code accepted for ' + resetEmail + '. Type the password you want, twice.');
        showResetAlert(result.message || 'Code accepted.', 'good');

        const password = document.getElementById('reset-new-password');
        if (password) password.focus();
    } catch (error) {
        showResetAlert('The server is not answering. Start it with npm start in the project folder, then try again.');
    } finally {
        setBusy('reset-verify-btn', false, 'Verify Code', 'Checking...');
    }
}

async function handleResetConfirm(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const newPassword = form.elements.newPassword.value;
    const confirmPassword = form.elements.confirmPassword.value;

    const complaint = passwordComplaint(newPassword);
    if (complaint) {
        showResetAlert(complaint);
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
        const response = await apiConfirmResetCode(resetEmail, resetCode, newPassword);
        const result = await response.json();

        if (!response.ok) {
            if (response.status === 400 && String(result.error || '').indexOf('code') !== -1) {
                form.reset();
                showPasswordRules();
                showResetCodeStep();
            }
            showResetAlert(result.error || 'The password was not changed.');
            return;
        }

        forgetLoadedPanels();
        localStorage.setItem('currentUser', JSON.stringify(result.user));
        window.location.replace(landingPageFor(result.user));
    } catch (error) {
        showResetAlert('The server is not answering. Start it with npm start in the project folder, then try again.');
    } finally {
        setBusy('reset-confirm-btn', false, 'Save the new password', 'Saving...');
    }
}
