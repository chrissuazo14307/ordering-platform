# Ordering Platform

A restaurant ordering system with four connected screens. Orders move through them automatically:

```
Customer menu ──place──▶ Review ──confirm──▶ KITCHEN DISPLAY ──Done──▶ CENTRAL SYSTEM ──▶ POS RECEIPT
     /                     (pending)            /kitchen        (invoice auto-created)   /receipt/:id
                                                                       /admin
```

| Screen | URL | Who uses it |
|---|---|---|
| Menu & ordering | `/` | Customers (phone, tablet or kiosk) |
| Kitchen display | `/kitchen` | Cook / person in charge of the kitchen |
| Central system | `/admin` | Cashier / manager: invoices, payments, records, menu |
| POS receipt | `/receipt/:id` | Opened from the central system and sent to the receipt printer |

## How an order flows

1. **Customer** browses the menu, adds items, enters name and table (or picks takeout) and taps **Place order**.
2. They review the order and tap **Confirm & send to kitchen**. Prices are always calculated on the server.
3. **Kitchen display** gets the ticket instantly, with a beep and no page refresh. It shows the items, table, notes or allergies, and a timer (the ticket turns red after 15 minutes). The cook can tap **Start cooking**, then **Done ✓**.
4. **Done** sends the order to the **central system**, which issues an invoice right away (`INV-000001`, …) with subtotal, tax and total, and records it.
5. In the central system the cashier clicks **🖨 Print POS** and **Take payment** (cash, card, e-wallet or other), then **Complete**. Turn on **Auto-print receipts** to open the print dialog as soon as the kitchen finishes an order.
6. The customer's screen updates live: Received → Cooking → Ready → Completed.

Every step is written to an audit trail (placed, confirmed, preparing, ready, invoiced, paid, receipt printed, closed) with timestamps. You can see it under **Details** in the central system.

## Run it

You need Node.js 22.5 or newer. There are no packages to install.

```bash
npm start
```

Then open http://localhost:3000. Staff screens ask for a login: username `staff`, password set by `STAFF_PIN` (default `1234`, which you should change).

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Web port |
| `STAFF_PIN` | `1234` | Password for kitchen and central system |
| `BUSINESS_NAME` | `My Restaurant` | Shown on the menu and receipt |
| `BUSINESS_ADDRESS` | `123 Main Street` | Receipt header |
| `BUSINESS_PHONE` | *(blank)* | Receipt header |
| `BUSINESS_TAX_ID` | *(blank)* | Printed as TIN on the receipt |
| `CURRENCY` | `USD` | e.g. `PHP`, `EUR`, `GBP` |
| `TAX_RATE` | `0.12` | 12% tax. Use `0` for no tax |
| `DB_FILE` | `./orders.db` | SQLite database file holding all records |

Example:

```bash
BUSINESS_NAME="Lola's Kitchen" CURRENCY=PHP TAX_RATE=0.12 STAFF_PIN=8842 npm start
```

## POS printing

The receipt is laid out for **80mm thermal receipt printers** (Epson TM series, Star, Xprinter and similar). Install the printer on the cashier computer, set it as the default printer and set its paper to 80mm. For 58mm printers, change `--w: 72mm` to `--w: 48mm` in `public/receipt.html`.

To print with no dialog at all, start Chrome on the cashier PC in kiosk printing mode:

```bash
chrome --kiosk-printing http://localhost:3000/admin
```

Every print is counted. Reprints from **Records** are marked "RECEIPT (REPRINT)".

## Records and invoicing

- **Records** tab: every order by date, including cancelled ones, with its invoice and payment status.
- **Export invoices (CSV)** downloads all invoices for Excel or your accountant.
- Tiles at the top show today's invoice count, gross sales, collected, outstanding and tax.
- An order can't be marked **Complete** until a payment is recorded.
- Order lines store the item name and price at the time of sale, so changing the menu later never alters past records.

## Menu management

Use the **Menu** tab in the central system to add items, edit names, prices and categories, or hide an item that has sold out. Changes show on the customer menu immediately.

## Using it on a local network

Run it on one computer (the cashier PC, for example) and open the screens from other devices on the same Wi-Fi:

- Kitchen tablet: `http://<cashier-pc-ip>:3000/kitchen`
- Customer phones, or a QR code on each table: `http://<cashier-pc-ip>:3000/`

To take orders from the internet, deploy it behind HTTPS (Render, Railway, a VPS with Caddy or nginx, and so on). Basic-auth passwords should only be sent over HTTPS.

## Tests

```bash
npm test
```

The test runs the whole flow: menu → place → confirm → kitchen → invoice → pay → print → close. It also checks security: staff pages need a login, and customers can only confirm or track their own order.

## Files

```
server.js          HTTP server, routing, live updates (Server-Sent Events), staff login
db.js              SQLite schema, order state machine, invoicing, audit trail
public/index.html  Customer menu & ordering
public/kitchen.html Kitchen display
public/admin.html  Central system
public/receipt.html 80mm POS receipt
test.js            End-to-end test
```
