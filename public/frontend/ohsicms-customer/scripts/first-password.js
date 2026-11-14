function portalSignedOut() {
    window.location.replace('/Login.html');
}

function showPasswordError(message, fieldId) {
    const box = document.getElementById('password-error');
    box.textContent = message;
    box.hidden = !message;
    for (const id of ['new-password', 'confirm-password']) {
        const input = document.getElementById(id);
        input.setAttribute('aria-invalid', String(id === fieldId));
        input.closest('.icon-field').classList.toggle('is-invalid', id === fieldId);
        if (id === fieldId) input.setAttribute('aria-describedby', 'password-error');
        else input.removeAttribute('aria-describedby');
    }
    if (fieldId) document.getElementById(fieldId).focus();
}

async function checkCustomerSession() {
    showPasswordRules();
    try {
        const result = await apiPortalMe();
        if (!result.ok) { portalSignedOut(); return; }
        if (!result.body.mustChangePassword) window.location.replace('/ohsicms-customer/');
    } catch (error) {
        showPasswordError('Unable to reach the server. Refresh the page to try again.');
    }
}

async function saveCustomerPassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const complaint = passwordComplaint(form.elements.newPassword.value);
    if (complaint) {
        showPasswordError(complaint, 'new-password');
        return;
    }
    if (!form.elements.confirmPassword.value) {
        showPasswordError('Please type your new password again.', 'confirm-password');
        return;
    }
    if (form.elements.newPassword.value !== form.elements.confirmPassword.value) {
        showPasswordError('Passwords do not match. Please type the same password in both fields.', 'confirm-password');
        return;
    }
    button.disabled = true;
    showPasswordError('');
    try {
        const result = await apiPortalChangePassword({
            newPassword: form.elements.newPassword.value,
            confirmPassword: form.elements.confirmPassword.value
        });
        if (!result.ok) {
            showPasswordError(result.body.error || 'Unable to change your password.',
                result.status === 400 ? 'new-password' : undefined);
            return;
        }
        window.location.replace('/ohsicms-customer/');
    } catch (error) {
        showPasswordError('Unable to reach the server. Please try again.');
    } finally {
        button.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', checkCustomerSession);
