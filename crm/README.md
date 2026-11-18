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


## Customer advance (Razorpay Payment Links)

`crm_bookings.advance_paid` holds only money that Razorpay has confirmed. A booking that needs the advance waits in `AWAITING_ADVANCE`, and drivers see it only after a signed `payment_link.paid` webhook confirms the exact amount was captured in INR.

- **Which rides need it:** `advance_collection_policy` in `crm_settings` (trip types, a fare threshold, and the payment window in minutes, at least 15). On other rides the WhatsApp customer chooses between the online advance and full cash to the driver. If the policy is missing or invalid, every ride needs the advance.
- **Admin bookings** send `advance_mode`: `PAYMENT_LINK`, `FULL_CASH` (refused where the advance is required), or `WAIVED` (needs a reason; the admin id and reason are saved on the booking). The route now requires a valid admin session.
- **Waiving a pending advance:** on the dispatch board, finance or the super admin can waive the advance on a booking in `AWAITING_ADVANCE`, `ADVANCE_LINK_FAILED` or `ADVANCE_EXPIRED` (`POST /api/bookings/{id}/advance` with `{ "action": "waive", "reason" }`). The open Razorpay link is cancelled first. If Razorpay reports the link already paid, or cannot be reached, nothing changes. The booking then becomes `FULL_CASH`, records who waived it and why, and goes to drivers. Refused for a pickup time that has passed, or for money already received after the booking closed (`PAID_AFTER_CLOSE`: reinstate or refund instead).
- **Statuses:** `AWAITING_ADVANCE` → `CONFIRMED_AWAITING_DRIVER` → normal dispatch. Unpaid links end in `ADVANCE_EXPIRED`. If Razorpay cannot create the link, the booking becomes `ADVANCE_LINK_FAILED`. None of these can be broadcast or force-assigned. A payment that does not match is marked `REVIEW_REQUIRED` on `crm_payment_links`, and admins get a WhatsApp alert. Money received after a booking closed is recorded as `PAID_AFTER_CLOSE`, for staff to reinstate the booking or refund.
- **Webhook:** `POST /api/payments/razorpay/webhook`. Subscribe to `payment_link.paid`, `payment_link.expired` and `payment_link.cancelled`. The HMAC is checked on the raw body before parsing, each `x-razorpay-event-id` is processed once, and the event claim and payment update commit together, so a failed attempt is retried by Razorpay.
- **Configuration:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (see `.env.example`). Until the webhook secret is set, webhook calls get 503.

Apply `crm-design/11_advance_collection.sql` before deploying. Existing bookings keep their values; rows that already carry an `advance_paid` (never actually collected) are marked `advance_status = 'LEGACY_UNVERIFIED'` for staff review. Tests use a disposable `_test` database with migrations 08 to 11:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/advance-payments.integration.ts
```

## Admin API authorization

The middleware runs without database access, so it only checks that a session cookie is present. Without one, API calls get 401 JSON and pages redirect to `/login`. **Every admin API route validates the session itself** at the start of each handler:

```ts
const auth = await requireAdmin(req, 'ledger.settle');  // src/lib/auth.ts
if (auth instanceof NextResponse) return auth;          // 401: no valid, unexpired session of an active admin; 403: role lacks the permission
```

Role permissions are defined once in `src/lib/permissions.ts`. The API enforces them, and the sidebar uses the same map only to hide pages a role cannot use. Unknown roles get nothing.

| Area | SUPER_ADMIN | DISPATCHER | FINANCE_MANAGER |
|---|---|---|---|
| Bookings: view | ✓ | ✓ | ✓ |
| Bookings: create · dispatch / force-assign | ✓ | ✓ | |
| Waive a customer advance | ✓ | | ✓ |
| Drivers and ratings: view | ✓ | ✓ | ✓ |
| Drivers: add / edit · ratings: dispute | ✓ | ✓ | |
| Incentives · finance ledger · settle trip | ✓ | | ✓ |
| Settings: view (secrets masked) | ✓ | ✓ | ✓ |
| Settings: change | ✓ | | |
| WhatsApp inbox / send | ✓ | ✓ | |
| Price quote | ✓ | ✓ | ✓ |

**Secrets in settings** (`meta_whatsapp_config.access_token`, `meta_whatsapp_config.webhook_verify_token`, `biharcabs_wp_api.api_key`; listed in `src/lib/settings-secrets.ts`) are never returned: a set value shows as `********`. Saving a setting with `********`, or without the field, keeps the stored secret; sending a new value replaces it.

Routes that are public on purpose, each with its own authentication: `auth/login`, `auth/logout`, `auth/me`, `whatsapp/webhook` (Meta signature), `payments/razorpay/webhook` (Razorpay signature), `dispatch/cron` and `dispatch/cron/daily` (`CRON_SECRET`). A test scans every `route.ts` and fails if any other handler lacks `requireAdmin(req, <permission>)`. It also calls every route as each role and checks the result against the table:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/admin-auth.integration.ts
```

## Driver payouts

A positive `crm_drivers.wallet_balance` is money BiharCabs owes the driver, e.g. when the customer's advance was more than BiharCabs' share of the ride. Finance records each payment on **Finance → Drivers Owed Money → Record payout**, or `POST /api/finance/payouts` with `{ driverId, amount, channel: UPI | BANK_TRANSFER | CASH, reference, notes? }`. Permission: `payouts.record` (SUPER_ADMIN, FINANCE_MANAGER).

- A payout writes a `DRIVER_PAYOUT_SENT` ledger entry (`recorded_by` = the admin) and lowers the wallet in the same transaction. The driver is told on WhatsApp.
- It can never exceed what is owed; concurrent payouts are serialised on the driver row.
- The same reference (UTR, bank reference or cash receipt number) can be recorded only once per channel.

Apply `crm-design/12_driver_payouts.sql` before deploying. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/payouts.integration.ts
```

**Commission setting:** bookings take commission from `revenue_protection_policy.platform_commission_pct` (Settings → "Platform Facilitation / Take-Rate"). The old `commission_model` and `driver_max_negative_balance_limit` settings were not used by any booking, dispatch or billing code, so their fields were removed from Settings. Credit limits are the tiered `dynamic_credit_limits`. The old rows remain in `crm_settings`, unused.

## Sign-in attempt limits

`POST /api/auth/login` records every attempt in `crm_login_attempts` (migration 13). Limits come from `login_security_policy` in `crm_settings` (defaults: 5 failures per email, 20 per IP, 15-minute window, 90 days of history). Invalid settings fall back to those defaults.

- **Per email:** after the limit, attempts are refused with 429 and `Retry-After` until the oldest counted failure is out of the window, even with the right password. Only failures since the last successful sign-in count. Unknown emails are counted and answered exactly like wrong passwords, and take the same time to answer, so nothing reveals which accounts exist. Attempts for one email are serialised, so parallel guesses cannot exceed the limit.
- **Per IP:** applies only when `CLIENT_IP_HEADER` names a header set by your reverse proxy. Otherwise any caller could forge `X-Forwarded-For`, so no IP is trusted.
- **Deactivated accounts** are reported only after a correct password.
- **Unlocking:** `scripts/set-admin-password.mjs` also clears that email's failed attempts; otherwise the lock lifts when the window passes.
- **Housekeeping:** the daily job (`/api/dispatch/cron/daily`) deletes attempts older than `retention_days`.

```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/login-limits.integration.ts
```

## Trip start OTP and cash settlement

- **OTP on assignment:** when a driver accepts a ride, the customer gets a trip OTP on WhatsApp (`trip_otp_policy`: 4 digits, 5 wrong entries). Only a hash is stored.
- **Starting the trip:** at pickup the driver taps **Start Trip** and types the code; only then is the trip `TRIP_IN_PROGRESS`. Wrong codes are counted under a row lock; after the limit the driver must ask the customer to reply **OTP**, which sends a new code and resets the count (admins are alerted when a trip locks).
- **Who can start:** only the assigned driver, while the booking is `DRIVER_ASSIGNED`. Bookings assigned before this change get a code when the driver taps Start Trip.
- **Completing:** **Complete Trip** works only on a started trip, and records the cash collected as **fare − advance confirmed by Razorpay**. On an advance ride BiharCabs owes the driver the advance minus its share; on a full-cash ride the driver owes the share.

Apply `crm-design/14_trip_start_otp.sql` before deploying. Tests drive the real bot handlers:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/trip-otp.integration.ts
```
