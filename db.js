// Data layer: SQLite via Node's built-in node:sqlite (no npm dependencies).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'orders.db');
const TAX_RATE = Number(process.env.TAX_RATE ?? 0.12); // e.g. 0.12 = 12%

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    available INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT UNIQUE,
    token TEXT NOT NULL,             -- secret given only to the customer who placed it
    customer_name TEXT NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'dine-in',   -- dine-in | takeout
    table_no TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    -- pending -> confirmed (sent to kitchen) -> preparing -> ready (sent to central system, invoiced) -> closed
    -- or cancelled
    status TEXT NOT NULL DEFAULT 'pending',
    subtotal_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    preparing_at TEXT,
    ready_at TEXT,
    closed_at TEXT,
    cancelled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER,
    name TEXT NOT NULL,              -- snapshot so records never change if the menu does
    unit_price_cents INTEGER NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    line_total_cents INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no TEXT UNIQUE NOT NULL,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
    subtotal_cents INTEGER NOT NULL,
    tax_rate REAL NOT NULL,
    tax_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',  -- unpaid | paid
    payment_method TEXT DEFAULT '',
    issued_at TEXT NOT NULL,
    paid_at TEXT,
    print_count INTEGER NOT NULL DEFAULT 0,
    last_printed_at TEXT
  );

  -- Audit trail of every event for record tracking
  CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    event TEXT NOT NULL,
    detail TEXT DEFAULT '',
    at TEXT NOT NULL
  );
`);

// Seed a sample menu on first run (edit from the Central System screen).
if (db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n === 0) {
  const ins = db.prepare('INSERT INTO menu_items (name, description, category, price_cents) VALUES (?, ?, ?, ?)');
  [
    ['Classic Burger', 'Beef patty, cheddar, lettuce, tomato, house sauce', 'Mains', 1250],
    ['Chicken Adobo Rice Bowl', 'Braised chicken, garlic rice, pickled papaya', 'Mains', 1100],
    ['Grilled Salmon', 'Lemon butter, seasonal vegetables', 'Mains', 1890],
    ['Margherita Pizza', 'Tomato, mozzarella, fresh basil', 'Mains', 1400],
    ['Caesar Salad', 'Romaine, parmesan, croutons', 'Starters', 850],
    ['Crispy Calamari', 'Garlic aioli', 'Starters', 950],
    ['Tomato Soup', 'With grilled cheese dippers', 'Starters', 700],
    ['Fries', 'Sea salt', 'Sides', 400],
    ['Garlic Rice', '', 'Sides', 300],
    ['Iced Tea', 'House-brewed', 'Drinks', 300],
    ['Fresh Lemonade', '', 'Drinks', 350],
    ['Espresso', '', 'Drinks', 280],
    ['Chocolate Lava Cake', 'With vanilla ice cream', 'Desserts', 750],
    ['Leche Flan', '', 'Desserts', 550],
  ].forEach((r) => ins.run(...r));
}

const now = () => new Date().toISOString();
const pad = (n, w = 6) => String(n).padStart(w, '0');

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function logEvent(orderId, event, detail = '') {
  db.prepare('INSERT INTO order_events (order_id, event, detail, at) VALUES (?, ?, ?, ?)').run(orderId, event, detail, now());
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- Menu ----------
function listMenu({ includeUnavailable = false } = {}) {
  const sql = `SELECT * FROM menu_items ${includeUnavailable ? '' : 'WHERE available = 1'} ORDER BY
    CASE category WHEN 'Starters' THEN 1 WHEN 'Mains' THEN 2 WHEN 'Sides' THEN 3 WHEN 'Drinks' THEN 4 WHEN 'Desserts' THEN 5 ELSE 6 END, name`;
  return db.prepare(sql).all().map((m) => ({ ...m, available: !!m.available }));
}

function upsertMenuItem(data, id) {
  const name = String(data.name || '').trim();
  const category = String(data.category || '').trim();
  const price = Math.round(Number(data.price) * 100);
  if (!name || !category || !Number.isFinite(price) || price < 0) throw new HttpError(400, 'Name, category and a valid price are required');
  const desc = String(data.description || '').trim();
  const available = data.available === false ? 0 : 1;
  if (id) {
    const r = db.prepare('UPDATE menu_items SET name=?, description=?, category=?, price_cents=?, available=? WHERE id=?').run(name, desc, category, price, available, id);
    if (!r.changes) throw new HttpError(404, 'Menu item not found');
    return db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
  }
  const r = db.prepare('INSERT INTO menu_items (name, description, category, price_cents, available) VALUES (?, ?, ?, ?, ?)').run(name, desc, category, price, available);
  return db.prepare('SELECT * FROM menu_items WHERE id=?').get(r.lastInsertRowid);
}

// ---------- Orders ----------
function getOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT name, unit_price_cents, qty, line_total_cents FROM order_items WHERE order_id=? ORDER BY id').all(id);
  o.invoice = db.prepare('SELECT * FROM invoices WHERE order_id=?').get(id) || null;
  return o;
}

function listOrders({ statuses, date, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (statuses?.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
  if (date) { where.push('substr(created_at,1,10) = ?'); args.push(date); }
  const rows = db.prepare(`SELECT id FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit);
  return rows.map((r) => getOrder(r.id));
}

function createOrder(data) {
  const name = String(data.customer_name || '').trim().slice(0, 80);
  const type = data.order_type === 'takeout' ? 'takeout' : 'dine-in';
  const table = String(data.table_no || '').trim().slice(0, 20);
  const notes = String(data.notes || '').trim().slice(0, 500);
  if (!name) throw new HttpError(400, 'Please enter a name for the order');
  if (type === 'dine-in' && !table) throw new HttpError(400, 'Please enter your table number');
  if (!Array.isArray(data.items) || data.items.length === 0) throw new HttpError(400, 'Your cart is empty');

  return tx(() => {
    const lines = [];
    for (const it of data.items) {
      const qty = Math.floor(Number(it.qty));
      if (!(qty > 0 && qty <= 99)) throw new HttpError(400, 'Invalid quantity');
      const m = db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(it.id));
      if (!m || !m.available) throw new HttpError(400, `"${m?.name || 'An item'}" is no longer available`);
      lines.push({ m, qty, line: m.price_cents * qty }); // price always comes from the server, never the client
    }
    const subtotal = lines.reduce((s, l) => s + l.line, 0);
    const tax = Math.round(subtotal * TAX_RATE);
    const r = db.prepare(`INSERT INTO orders (token, customer_name, order_type, table_no, notes, status, subtotal_cents, tax_cents, total_cents, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(crypto.randomBytes(16).toString('hex'), name, type, type === 'dine-in' ? table : '', notes, subtotal, tax, subtotal + tax, now());
    const id = Number(r.lastInsertRowid);
    db.prepare('UPDATE orders SET order_no=? WHERE id=?').run('ORD-' + pad(id), id);
    const insItem = db.prepare('INSERT INTO order_items (order_id, menu_item_id, name, unit_price_cents, qty, line_total_cents) VALUES (?, ?, ?, ?, ?, ?)');
    for (const l of lines) insItem.run(id, l.m.id, l.m.name, l.m.price_cents, l.qty, l.line);
    logEvent(id, 'placed', `${lines.length} line(s), total ${subtotal + tax}`);
    return getOrder(id);
  });
}

// Allowed transitions. "ready" automatically creates the invoice in the central system.
const TRANSITIONS = {
  confirm:  { from: ['pending'], to: 'confirmed', stamp: 'confirmed_at' },
  prepare:  { from: ['confirmed'], to: 'preparing', stamp: 'preparing_at' },
  ready:    { from: ['confirmed', 'preparing'], to: 'ready', stamp: 'ready_at' },
  close:    { from: ['ready'], to: 'closed', stamp: 'closed_at' },
  cancel:   { from: ['pending', 'confirmed', 'preparing'], to: 'cancelled', stamp: 'cancelled_at' },
};

function transition(id, action, detail = '') {
  const t = TRANSITIONS[action];
  if (!t) throw new HttpError(400, 'Unknown action');
  return tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!t.from.includes(o.status)) throw new HttpError(409, `Cannot ${action} an order that is ${o.status}`);
    if (action === 'close') {
      const inv = db.prepare('SELECT payment_status FROM invoices WHERE order_id=?').get(id);
      if (inv?.payment_status !== 'paid') throw new HttpError(409, 'Record the payment before completing the order');
    }
    db.prepare(`UPDATE orders SET status=?, ${t.stamp}=? WHERE id=?`).run(t.to, now(), id);
    logEvent(id, t.to, detail);

    if (t.to === 'ready') {
      // Kitchen finished -> hand off to central system: issue invoice & record it.
      const r = db.prepare(`INSERT INTO invoices (invoice_no, order_id, subtotal_cents, tax_rate, tax_cents, total_cents, issued_at)
        VALUES ('TMP', ?, ?, ?, ?, ?, ?)`).run(id, o.subtotal_cents, TAX_RATE, o.tax_cents, o.total_cents, now());
      const invNo = 'INV-' + pad(Number(r.lastInsertRowid));
      db.prepare('UPDATE invoices SET invoice_no=? WHERE id=?').run(invNo, r.lastInsertRowid);
      logEvent(id, 'invoiced', invNo);
    }
    return getOrder(id);
  });
}

function markPaid(id, method) {
  const allowed = ['cash', 'card', 'e-wallet', 'other'];
  if (!allowed.includes(method)) throw new HttpError(400, 'Invalid payment method');
  return tx(() => {
    const inv = db.prepare('SELECT * FROM invoices WHERE order_id=?').get(id);
    if (!inv) throw new HttpError(409, 'Order has not been invoiced yet');
    if (inv.payment_status === 'paid') throw new HttpError(409, 'Invoice already paid');
    db.prepare("UPDATE invoices SET payment_status='paid', payment_method=?, paid_at=? WHERE id=?").run(method, now(), inv.id);
    logEvent(id, 'paid', method);
    return getOrder(id);
  });
}

function recordPrint(id) {
  const r = db.prepare('UPDATE invoices SET print_count = print_count + 1, last_printed_at=? WHERE order_id=?').run(now(), id);
  if (!r.changes) throw new HttpError(409, 'Order has not been invoiced yet');
  logEvent(id, 'receipt_printed');
  return getOrder(id);
}

function orderEvents(id) {
  return db.prepare('SELECT event, detail, at FROM order_events WHERE order_id=? ORDER BY id').all(id);
}

function dailySummary(date) {
  return db.prepare(`
    SELECT COUNT(*) AS invoices,
      COALESCE(SUM(total_cents),0) AS gross_cents,
      COALESCE(SUM(tax_cents),0) AS tax_cents,
      COALESCE(SUM(CASE WHEN payment_status='paid' THEN total_cents END),0) AS paid_cents,
      COALESCE(SUM(CASE WHEN payment_status='unpaid' THEN total_cents END),0) AS unpaid_cents
    FROM invoices WHERE substr(issued_at,1,10) = ?`).get(date);
}

module.exports = {
  db, TAX_RATE, HttpError,
  listMenu, upsertMenuItem,
  createOrder, getOrder, listOrders, transition, markPaid, recordPrint, orderEvents, dailySummary,
};
