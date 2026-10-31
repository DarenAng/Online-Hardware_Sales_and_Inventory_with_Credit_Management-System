// The first card on Login.html: choose Customer log in or Staff log in, then show that form.
const LOGIN_CARDS = ['choice-card', 'sign-in-card', 'customer-card'];

function showLoginCard(id) {
    for (let i = 0; i < LOGIN_CARDS.length; i++) {
        const card = document.getElementById(LOGIN_CARDS[i]);
        if (card) card.hidden = LOGIN_CARDS[i] !== id;
    }
}

function showLoginChoice() {
    showLoginCard('choice-card');
}

function showLoginForm(who) {
    if (who === 'customer') {
        showLoginCard('customer-card');
        document.getElementById('customer-id').focus();
    } else {
        showLoginCard('sign-in-card');
        document.getElementById('login-email').focus();
    }
}

function showCustomerAlert(message) {
    const box = document.getElementById('customer-alert');
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
}

async function handleCustomerLogin(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const button = document.getElementById('customer-submit');
    document.getElementById('customer-alert').hidden = true;
    button.disabled = true;

    try {
        const response = await fetch('/api/portal/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerId: form.elements.customerId.value.trim(),
                password: form.elements.password.value
            })
        });
        const result = await response.json();

        if (!response.ok) {
            let text = String(result.error || 'That log in did not work').replace(/[.!]?$/, '.');
            if (result.warning) text += ' ' + result.warning;
            showCustomerAlert(text);
            form.elements.password.value = '';
            form.elements.password.focus();
            return;
        }

        window.location.replace('/ohsicms-customer/');
    } catch (error) {
        showCustomerAlert('The server did not answer. Check that it is still running, then try again.');
    } finally {
        button.disabled = false;
    }
}

// Whenever the staff form shows a message (including one that arrives late, after a check with the
// server), show the staff form so the message is seen.
const showStaffAlert = showLoginAlert;
showLoginAlert = function (message, tone) {
    showStaffAlert(message, tone);
    showLoginCard('sign-in-card');
};

// A staff session that ended leaves its message on the staff form, so open that form.
document.addEventListener('DOMContentLoaded', function () {
    const staffAlert = document.getElementById('login-alert');
    if (staffAlert && !staffAlert.hidden) showLoginCard('sign-in-card');

    // A customer whose portal session ended comes back here with the reason.
    let reason = null;
    try {
        reason = sessionStorage.getItem('customerSignOutReason');
        sessionStorage.removeItem('customerSignOutReason');
    } catch (error) {  }
    if (reason !== null) {
        showLoginCard('customer-card');
        if (reason !== '') showCustomerAlert(reason);
    }
});
