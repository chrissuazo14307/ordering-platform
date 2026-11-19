// Ordering platform server: zero npm dependencies (Node >= 22.5).
//   /          Customer menu & ordering
//   /kitchen   Kitchen display (staff)
//   /admin     Central system: invoicing, records, menu (staff)
//   /receipt/N POS receipt (80mm thermal) (staff)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');

const PORT = Number(process.env.PORT || 3000);
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const BUSINESS = {
  name: process.env.BUSINESS_NAME || 'My Restaurant',
  address: process.env.BUSINESS_ADDRESS || '123 Main Street',
  phone: process.env.BUSINESS_PHONE || '',
  taxId: process.env.BUSINESS_TAX_ID || '',
  currency: process.env.CURRENCY || 'USD',
  taxRate: store.TAX_RATE,
};

// ---------- Live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(type, order) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(order)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

// ---------- Helpers ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new store.HttpError(413, 'Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new store.HttpError(400, 'Invalid JSON')); } });
  });
}

function isStaff(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return pass === STAFF_PIN;
}
function requireStaff(req, res) {
  if (isStaff(req)) return true;
  send(res, 401, 'Staff login required (username: staff, password: your STAFF_PIN)', { 'WWW-Authenticate': 'Basic realm="Staff", charset="UTF-8"' });
  return false;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveFile(res, file) {
  const p = path.join(__dirname, 'public', file);
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// Public view of an order (what a customer may see about their own order).
const publicOrder = (o, withToken = false) => o && ({
  ...(withToken ? { token: o.token } : {}),
  id: o.id, order_no: o.order_no, status: o.status, customer_name: o.customer_name, order_type: o.order_type, table_no: o.table_no,
  items: o.items, subtotal_cents: o.subtotal_cents, tax_cents: o.tax_cents, total_cents: o.total_cents, created_at: o.created_at,
});

// Customer endpoints require the order's secret token (?t=...)
function customerOrder(id, url) {
  const o = store.getOrder(id);
  if (!o || o.token !== url.searchParams.get('t')) throw new store.HttpError(404, 'Order not found');
  return o;
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = (re) => p.match(re);
  let mm;

  try {
    // Pages
    if (req.method === 'GET') {
      if (p === '/') return serveFile(res, 'index.html');
      if (p === '/kitchen') return requireStaff(req, res) && serveFile(res, 'kitchen.html');
      if (p === '/admin') return requireStaff(req, res) && serveFile(res, 'admin.html');
      if (m(/^\/receipt\/\d+$/)) return requireStaff(req, res) && serveFile(res, 'receipt.html');
      if (m(/^\/(styles\.css|common\.js)$/)) return serveFile(res, p.slice(1));
    }

    // ----- Public API -----
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, BUSINESS);
    if (p === '/api/menu' && req.method === 'GET') return send(res, 200, store.listMenu());

    if (p === '/api/orders' && req.method === 'POST') {
      const o = store.createOrder(await readJson(req));
      return send(res, 201, publicOrder(o, true));
    }
    // Customer confirms their placed order -> goes straight to the kitchen
    if ((mm = m(/^\/api\/orders\/(\d+)\/confirm$/)) && req.method === 'POST') {
      const o = store.transition(customerOrder(Number(mm[1]), url).id, 'confirm', 'by customer');
      broadcast('order', o);
      return send(res, 200, publicOrder(o));
    }
    if ((mm = m(/^\/api\/orders\/(\d+)\/track$/)) && req.method === 'GET') {
      return send(res, 200, publicOrder(customerOrder(Number(mm[1]), url)));
    }
    if ((mm = m(/^\/api\/orders\/(\d+)\/cancel-pending$/)) && req.method === 'POST') {
      const o = customerOrder(Number(mm[1]), url);
      if (o.status !== 'pending') return send(res, 409, { error: 'Only unconfirmed orders can be cancelled here' });
      return send(res, 200, publicOrder(store.transition(o.id, 'cancel', 'by customer before confirming')));
    }

    // ----- Staff API -----
    if (p.startsWith('/api/staff/')) {
      if (!requireStaff(req, res)) return;

      if (p === '/api/staff/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/staff/orders' && req.method === 'GET') {
        const statuses = url.searchParams.get('status')?.split(',').filter(Boolean);
        return send(res, 200, store.listOrders({ statuses, date: url.searchParams.get('date') || undefined }));
      }
      if ((mm = m(/^\/api\/staff\/orders\/(\d+)$/)) && req.method === 'GET') {
        const o = store.getOrder(Number(mm[1]));
        return o ? send(res, 200, { ...o, events: store.orderEvents(o.id) }) : send(res, 404, { error: 'Order not found' });
      }
      if ((mm = m(/^\/api\/staff\/orders\/(\d+)\/(prepare|ready|close|cancel)$/)) && req.method === 'POST') {
        const body = await readJson(req);
        const o = store.transition(Number(mm[1]), mm[2], body.reason || 'by staff');
        broadcast(mm[2] === 'ready' ? 'invoiced' : 'order', o);
        return send(res, 200, o);
      }
      if ((mm = m(/^\/api\/staff\/orders\/(\d+)\/pay$/)) && req.method === 'POST') {
        const o = store.markPaid(Number(mm[1]), (await readJson(req)).method);
        broadcast('order', o);
        return send(res, 200, o);
      }
      if ((mm = m(/^\/api\/staff\/orders\/(\d+)\/printed$/)) && req.method === 'POST') {
        const o = store.recordPrint(Number(mm[1]));
        broadcast('order', o);
        return send(res, 200, o);
      }
      if (p === '/api/staff/summary' && req.method === 'GET') {
        return send(res, 200, store.dailySummary(url.searchParams.get('date') || new Date().toISOString().slice(0, 10)));
      }
      if (p === '/api/staff/menu' && req.method === 'GET') return send(res, 200, store.listMenu({ includeUnavailable: true }));
      if (p === '/api/staff/menu' && req.method === 'POST') return send(res, 201, store.upsertMenuItem(await readJson(req)));
      if ((mm = m(/^\/api\/staff\/menu\/(\d+)$/)) && req.method === 'PUT') return send(res, 200, store.upsertMenuItem(await readJson(req), Number(mm[1])));
      if (p === '/api/staff/export.csv' && req.method === 'GET') {
        const rows = store.db.prepare(`SELECT i.invoice_no, o.order_no, i.issued_at, o.customer_name, o.order_type, o.table_no,
          i.subtotal_cents, i.tax_cents, i.total_cents, i.payment_status, i.payment_method, i.paid_at
          FROM invoices i JOIN orders o ON o.id = i.order_id ORDER BY i.id`).all();
        const cols = ['invoice_no', 'order_no', 'issued_at', 'customer_name', 'order_type', 'table_no', 'subtotal', 'tax', 'total', 'payment_status', 'payment_method', 'paid_at'];
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = [cols.join(',')].concat(rows.map((r) => [r.invoice_no, r.order_no, r.issued_at, r.customer_name, r.order_type, r.table_no,
          (r.subtotal_cents / 100).toFixed(2), (r.tax_cents / 100).toFixed(2), (r.total_cents / 100).toFixed(2), r.payment_status, r.payment_method, r.paid_at].map(esc).join(','))).join('\n');
        return send(res, 200, csv, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="invoices.csv"' });
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Ordering platform running:
  Customer menu   http://localhost:${PORT}/
  Kitchen display http://localhost:${PORT}/kitchen
  Central system  http://localhost:${PORT}/admin
  Staff login     username "staff", password "${STAFF_PIN === '1234' ? '1234 (default - set STAFF_PIN!)' : '<STAFF_PIN>'}"`);
  });
}
module.exports = server;
