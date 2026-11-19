// End-to-end test of the full flow: menu -> place -> confirm -> kitchen -> invoice -> pay -> print -> close
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordtest-')), 'test.db');
process.env.STAFF_PIN = 'testpin';
const server = require('./server');

const STAFF = { Authorization: 'Basic ' + Buffer.from('staff:testpin').toString('base64') };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };

  // Live event stream, like the kitchen screen
  const events = [];
  const ctrl = new AbortController();
  fetch(base + '/api/staff/events', { headers: STAFF, signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    for await (const chunk of res.body) for (const m of dec.decode(chunk).matchAll(/event: (\w+)/g)) events.push(m[1]);
  }).catch(() => {});

  const menu = (await call('GET', '/api/menu')).body;
  assert.ok(menu.length > 5, 'menu loaded');

  // Validation
  assert.equal((await call('POST', '/api/orders', { customer_name: 'A', order_type: 'dine-in', items: [{ id: menu[0].id, qty: 1 }] })).status, 400, 'table required');
  assert.equal((await call('POST', '/api/orders', { customer_name: 'A', order_type: 'takeout', items: [] })).status, 400, 'empty cart');

  // Place
  const placed = await call('POST', '/api/orders', { customer_name: 'Maria', order_type: 'dine-in', table_no: '7', notes: 'no onions',
    items: [{ id: menu[0].id, qty: 2, price: 1 /* ignored: server prices */ }, { id: menu[1].id, qty: 1 }] });
  assert.equal(placed.status, 201);
  const o = placed.body;
  assert.equal(o.status, 'pending');
  assert.equal(o.subtotal_cents, menu[0].price_cents * 2 + menu[1].price_cents, 'server-side pricing');

  // Pending orders are NOT on the kitchen screen
  let kitchen = (await call('GET', '/api/staff/orders?status=confirmed,preparing', null, STAFF)).body;
  assert.equal(kitchen.length, 0);

  // Security: wrong token, no staff auth
  assert.equal((await call('POST', `/api/orders/${o.id}/confirm?t=wrong`)).status, 404);
  assert.equal((await call('GET', '/api/staff/orders')).status, 401);
  assert.equal((await call('GET', '/kitchen')).status, 401);

  // Confirm -> goes to kitchen
  assert.equal((await call('POST', `/api/orders/${o.id}/confirm?t=${o.token}`)).body.status, 'confirmed');
  kitchen = (await call('GET', '/api/staff/orders?status=confirmed,preparing', null, STAFF)).body;
  assert.equal(kitchen.length, 1);
  assert.equal(kitchen[0].notes, 'no onions');

  // Kitchen: start cooking, then done -> invoice created in central system
  assert.equal((await call('POST', `/api/staff/orders/${o.id}/prepare`, {}, STAFF)).body.status, 'preparing');
  const ready = (await call('POST', `/api/staff/orders/${o.id}/ready`, {}, STAFF)).body;
  assert.equal(ready.status, 'ready');
  assert.match(ready.invoice.invoice_no, /^INV-\d{6}$/);
  assert.equal(ready.invoice.total_cents, o.total_cents);

  // Can't complete before payment
  assert.equal((await call('POST', `/api/staff/orders/${o.id}/close`, {}, STAFF)).status, 409);
  // Pay, print, close
  assert.equal((await call('POST', `/api/staff/orders/${o.id}/pay`, { method: 'cash' }, STAFF)).body.invoice.payment_status, 'paid');
  assert.equal((await call('POST', `/api/staff/orders/${o.id}/printed`, {}, STAFF)).body.invoice.print_count, 1);
  assert.equal((await call('POST', `/api/staff/orders/${o.id}/close`, {}, STAFF)).body.status, 'closed');

  // Records
  const detail = (await call('GET', `/api/staff/orders/${o.id}`, null, STAFF)).body;
  assert.deepEqual(detail.events.map((e) => e.event), ['placed', 'confirmed', 'preparing', 'ready', 'invoiced', 'paid', 'receipt_printed', 'closed']);
  const sum = (await call('GET', '/api/staff/summary', null, STAFF)).body;
  assert.equal(sum.invoices, 1); assert.equal(sum.paid_cents, o.total_cents);
  const csv = (await call('GET', '/api/staff/export.csv', null, STAFF)).body;
  assert.match(csv, /INV-000001/);
  assert.equal((await call('GET', '/receipt/1', null, STAFF)).status, 200);

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(events.includes('order') && events.includes('invoiced'), 'live events pushed: ' + events.join(','));

  console.log('✓ All checks passed: menu → place → confirm → kitchen → invoice → pay → print → close');
  ctrl.abort(); server.closeAllConnections(); server.close(); process.exit(0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
