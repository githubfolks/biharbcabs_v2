# BiharCabs.com Operational CRM & WhatsApp Dispatch Engine

This application implements the end-to-end operational CRM and automated WhatsApp dispatch workflows designed in [`../crm-design/biharcabs_whatsapp_crm_design.md`](../crm-design/biharcabs_whatsapp_crm_design.md).

## Architectural Principles
1. **Zero Hardcoded Values:** All SLA timers, commission percentage/fixed margin rules, advance amounts, WhatsApp template names, Meta API credentials, and WordPress API URLs are stored in and dynamically retrieved from the native PostgreSQL `crm_settings` table.
2. **Native PostgreSQL Database:** The database `biharcabs_crm` runs natively on the macOS / Linux VPS host OS (port 5432 / `/tmp` socket), completely separate from Docker.
3. **Dual-Database Separation:** Pricing & SEO route tariffs are read from the BiharCabs WordPress database (`/wp-json/biharcabs/v1/quote`), while all operational entities (Bookings, Drivers, Dispatch Offers, Ledger, Invoices) reside in native PostgreSQL.
4. **No Synthetic Data:** Real queries with graceful failure handling if a route is unlisted or custom quote is needed.

---

## Database Setup & Migrations
The initial schema and dynamic settings are defined in [`crm-design/01_init_crm_schema.sql`](../crm-design/01_init_crm_schema.sql).

To re-apply or inspect the schema:
```bash
psql -h /tmp -d biharcabs_crm -f ../crm-design/01_init_crm_schema.sql
```

Tables created:
- `crm_settings` (Dynamic configuration store)
- `crm_customers` (Customer contacts and GST details)
- `crm_drivers` (KYC, wallet balances, and availability)
- `crm_driver_vehicles` (Category mapping and document expiries)
- `crm_bookings` (Full trip lifecycle with atomic status state machine)
- `crm_dispatch_offers` (Broadcast offers sent to drivers)
- `crm_payments_ledger` (Bidirectional driver wallet and customer accounting)
- `crm_invoices` (Tax invoice records)
- `crm_whatsapp_logs` (Full audit trail for incoming & outgoing messages)

---

## Running Locally

### 1. Environment Configuration
Verify `crm/.env.local`:
```bash
DATABASE_URL=postgresql://vikram@localhost:5432/biharcabs_crm
PORT=3001
WP_API_BASE_URL=http://localhost:8080
```

### 2. Start the Development Server
```bash
cd crm
npm run dev
```
Open **[http://localhost:3001](http://localhost:3001)** to access the BiharCabs CRM Dashboard.

### Admin Authentication & Login Credentials
The CRM requires authentication to protect dispatch, driver, finance, and settings data:
- **Login URL:** [http://localhost:3001/login](http://localhost:3001/login)
- **Admin accounts:** no default admin is seeded. Create one, or reset a password, from the `crm` folder:
  `CRM_ADMIN_EMAIL=you@example.com node scripts/set-admin-password.mjs`
  It prints a generated password once, or uses `CRM_ADMIN_PASSWORD` if set, and signs out that admin's sessions.
- Password hashing is enforced using Node.js `crypto.scrypt` with constant-time equality validation.
- Sessions are stored in the native PostgreSQL `crm_admin_sessions` table and managed via secure `HttpOnly` cookies.

- **Live Dispatch Board (`/`):** View rides, trigger broadcasts to matching verified drivers, force assign drivers, and monitor SLAs.
- **Driver & Fleet Hub (`/drivers`):** Onboard drivers, link vehicles (Sedan, Ertiga SUV, Innova, Tempo), verify KYC and document expiry dates.
- **Finance & Commission Ledger (`/finance`):** Bidirectional commission settlements, cash collected vs online payments, and PDF tax invoices.
- **Dynamic System Settings (`/settings`):** Real-time editor for SLA timeouts, commission models, and API configurations.

### 3. Run Automated Core Engine Tests
```bash
cd crm
npx tsx --test src/tests/crm.test.ts
```


Return-trip pricing and pickup-time parsing have pure tests with no database:
```bash
npx tsx --test src/tests/return-trip-pricing.test.ts
```

The end-to-end return-trip test needs a disposable database whose name ends in `_test`, with the CRM schema, `crm_settings` and migration 08. It also needs the WordPress quote endpoint, with a rate card listing Patna to Darbhanga:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/return-trips.integration.ts
```

## Return Trips: Priority & Discount

When a driver drops a customer away from their base city, the CRM offers a **🔁 Returning home** button after **Complete Trip**. Tapping it marks the driver as returning, from the drop city to their base city, for the configured number of hours.

- **Discount at booking.** When a returning driver with a matching vehicle is free for a route and pickup time, the customer sees that vehicle discounted. The discount is recalculated from current settings when the booking is created.
- **Priority.** A discounted booking goes only to returning drivers for the priority window. After that, the 5-minute scheduled job (`/api/dispatch/cron`) sends it to regular drivers.
- **Who pays.** The company pays the discount up to its platform commission, with GST recalculated on what remains, and the returning driver pays the rest. If a regular driver takes the ride, the company pays it all and the driver earns the normal payout. Each booking records the discount, both shares, and `return_discount_funded_by`.
- **When it ends.** A driver's return ends when they tap **🏠 Reached home**, accept a return ride, or the time runs out.

Configure it under **Settings → Return Trips**. It stays off until a discount (% or flat ₹), the priority window and the return duration are all set. The server rejects incomplete settings.

Apply `crm-design/08_return_trips.sql` before deploying this code. It is safe to run more than once, never overwrites saved settings, and records itself in `crm_schema_migrations`.

The bot now asks customers for their pickup time, and drivers' ride alerts show it. Before this, bookings defaulted to the next day at 9:00 AM.

## Scheduled Jobs

n8n calls two endpoints on a schedule (setup in [`../n8n/README.md`](../n8n/README.md)):

- **`POST /api/dispatch/cron`, every 5 minutes:** return-trip windows, SLA escalation, driver wake-up checks, expired-document suspension, unpaid-dues restriction. Each job changes a status or records a sent time, so repeated runs do not repeat messages.
- **`POST /api/dispatch/cron/daily`, 09:00 IST:** reminders to drivers whose documents expire within 15 days. Nothing records who was reminded, so this must not run more than once a day.

Both require `Authorization: Bearer <CRON_SECRET>`. Until `CRON_SECRET` is set, every call is refused with 503; a wrong or missing secret gets 401. Apply `crm-design/10_driver_wakeup_sent.sql` before deploying: without `crm_bookings.wakeup_sent_at`, the 5-minute job fails at the wake-up step. Tests use a disposable `_test` database with migrations 08 to 10:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/cron.integration.ts
```

## WhatsApp Webhook Security

- **Signed events only.** `POST /api/whatsapp/webhook` checks Meta's `X-Hub-Signature-256` header, an HMAC-SHA256 of the raw body keyed with your App Secret, before reading the event. Set `META_APP_SECRET` in the environment, never in git or the database. Until it is set, every event is rejected with 503 and the bot does not respond. Unsigned or wrongly signed events get 401.
- **Each message once.** Meta retries deliveries for up to 36 hours. Every message id is recorded in `crm_webhook_events` and processed only once, so a repeated "Complete Trip" cannot settle a trip twice. A message is claimed before processing and is not reprocessed if processing fails part-way. Settlement also refuses a booking that is already settled.
- **Only the right person can act.**
  - **Accept a ride:** only a driver with a pending offer for it.
  - **Start or complete a trip:** only the assigned driver, at the right stage.
  - **See dues:** only that driver.
  - **Rate a trip:** only that trip's customer, once it is settled.

Apply `crm-design/09_webhook_events.sql` before deploying this code; without the table, webhook events fail. The security tests use a disposable `_test` database with migrations 08 and 09:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/security.integration.ts
```

