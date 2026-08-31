function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('active');
}

function switchTab(tabId) {
    const tabContents = document.querySelectorAll('.tab-content');
    const tabBtns = document.querySelectorAll('.tab-btn');

    tabContents.forEach(content => content.classList.remove('active'));
    tabBtns.forEach(btn => btn.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    event.currentTarget.classList.add('active');
}

async function handleLogin(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const email = form.elements.email.value;
    const password = form.elements.password.value;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const result = await response.json();

        if (!response.ok) {
            alert(result.error);
            return;
        }

        localStorage.setItem('currentUser', JSON.stringify(result.user));

        window.location.href = result.user.must_change_password
            ? 'change-password.html'
            : getRolePage(result.user.role_name);
    } catch (error) {
        alert('Cannot connect to the server. Start it with: node public/javascript/server.js');
    }
}

async function handlePasswordChange(event) {
    event.preventDefault();

    const currentUser = getCurrentUser();
    const form = event.currentTarget;
    const newPassword = form.elements.newPassword.value;
    const confirmPassword = form.elements.confirmPassword.value;

    if (!currentUser || !currentUser.must_change_password) {
        window.location.replace('Login.html');
        return;
    }

    if (newPassword !== confirmPassword) {
        alert('Passwords do not match.');
        return;
    }

    if (newPassword.length < 8) {
        alert('Password must contain at least 8 characters.');
        return;
    }

    try {
        const response = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.user_id, newPassword })
        });
        const result = await response.json();

        if (!response.ok) {
            alert(result.error);
            return;
        }

        currentUser.must_change_password = false;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        window.location.href = getRolePage(currentUser.role_name);
    } catch (error) {
        alert('Cannot connect to the server. Start it with: node public/javascript/server.js');
    }
}

function getRolePage(roleName) {
    const rolePages = {
        'System Administrator': 'system.html',
        Manager: 'manager-dashboard.html',
        'Inventory Clerk': 'inventory.html',
        Cashier: 'pos.html',
        'Delivery Personnel': 'delivery.html'
    };

    return rolePages[roleName] || 'index.html';
}

function logout() {
    localStorage.removeItem('currentUser');
}

function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem('currentUser') || 'null');
    } catch (error) {
        logout();
        return null;
    }
}

function initializeSession() {
    const currentUser = getCurrentUser();
    const pageName = window.location.pathname.split('/').pop().toLowerCase();

    if (pageName === 'login.html' || pageName === '') {
        logout();
        return;
    }

    if (!currentUser) {
        window.location.replace('Login.html');
        return;
    }

    if (pageName === 'index.html' && currentUser.role_name === 'Manager') {
        window.location.replace('manager-dashboard.html');
        return;
    }

    if (pageName === 'system.html' && currentUser.role_name !== 'System Administrator') {
        window.location.replace('index.html');
        return;
    }

    if (currentUser.must_change_password && pageName !== 'change-password.html') {
        window.location.replace('change-password.html');
        return;
    }

    if (pageName === 'change-password.html' && !currentUser.must_change_password) {
        window.location.replace(getRolePage(currentUser.role_name));
        return;
    }

    document.querySelectorAll('[data-current-user]').forEach((element) => {
        element.textContent = currentUser.first_name || currentUser.email;
    });
}

document.addEventListener('DOMContentLoaded', initializeSession);

function toggleDropdown(id, event) {
    if (event) {
        event.preventDefault();
    }
    const element = document.getElementById(id);
    if (element) {
        if (element.style.display === 'none') {
            element.style.display = 'block';
        } else {
            element.style.display = 'none';
        }
    }
}

function toggleRowActions(row) {
    const actions = row.querySelector('.row-actions');
    if (actions) {
        if (actions.style.display === 'none') {
            actions.style.display = 'block';
        } else {
            actions.style.display = 'none';
        }
    }
}

async function loadUsers() {
    try {
        const response = await fetch('/api/users');
        const users = await response.json();
        const tbody = document.querySelector('#accounts-table tbody');
        if(!tbody) return;
        tbody.innerHTML = '';
        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = function() { toggleRowActions(this); };
            tr.innerHTML = `
                <td>
                    ${user.first_name || 'No Name'}
                    <div class="row-actions" style="display: none; margin-top: 10px;">
                        <button class="btn" style="padding: 5px 10px;" onclick="event.stopPropagation();">Update</button>
                        <button class="btn btn-danger" style="padding: 5px 10px;" onclick="event.stopPropagation();">Deactivate</button>
                    </div>
                </td>
                <td>${user.email}</td>
                <td>${user.role_name || 'N/A'}</td>
                <td style="color: var(--success);">Active</td>
            `;
            tbody.appendChild(tr);
        });
    } catch(err) {
        console.error("Error loading users:", err);
    }
}

async function handleCreateUser(event) {
    event.preventDefault();
    const form = event.target;
    const data = {
        firstName: form.firstName.value,
        email: form.email.value,
        password: form.password.value,
        roleId: parseInt(form.roleId.value)
    };

    try {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if(!response.ok) {
            alert(result.error);
            return;
        }
        alert("User created successfully!");
        form.reset();
        showAccountsList();
        loadUsers();
    } catch(err) {
        alert("Cannot connect to server.");
    }
}

function showAccountsList(event) {
    if(event) event.preventDefault();
    document.getElementById('accounts').style.display = 'block';
    document.getElementById('accounts-create').style.display = 'none';
}

function showCreateAccount(event) {
    if(event) event.preventDefault();
    document.getElementById('accounts').style.display = 'none';
    document.getElementById('accounts-create').style.display = 'block';
}

if (window.location.pathname.toLowerCase().endsWith('system.html')) {
    document.addEventListener('DOMContentLoaded', loadUsers);
}