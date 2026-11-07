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

