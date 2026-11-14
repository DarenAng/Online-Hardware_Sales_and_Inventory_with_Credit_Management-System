// Demo login addresses only; this does not create Gmail mailboxes.
async function fillDemoEmails(db) {
  const result = await db.query("SELECT customer_id, first_name, last_name FROM customers WHERE portal_email IS NULL ORDER BY customer_id");
  for (const customer of result[0]) {
    let name = (customer.first_name + '.' + customer.last_name).toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (!name.replace(/\./g, '')) name = 'customer';
    let email = name + '@gmail.com';
    let suffix = 0;
    while (true) {
      const used = await db.query("SELECT customer_id FROM customers WHERE portal_email = ?", [email]);
      if (!used[0].length) break;
      suffix++;
      email = name + customer.customer_id + (suffix > 1 ? '.' + suffix : '') + '@gmail.com';
    }
    await db.query("UPDATE customers SET portal_email = ? WHERE customer_id = ? AND portal_email IS NULL", [email, customer.customer_id]);
  }
}
module.exports = { fillDemoEmails: fillDemoEmails };
