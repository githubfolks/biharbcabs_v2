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

## GST (per BiharCabs' CA)

- **Ride fare:** BiharCabs is liable under CGST Sec 9(5) for GST on the full fare, at `company_billing_info.tax_percentage` (5%). Quoted fares include it, and the **driver bears it**: it is part of BiharCabs' share of each ride (owner decision).
- **Commission + ₹10 tech fee** charged to the driver: 18% GST on both together, **added on top** (`gst_on_commission_pct`). The ₹10 fee becomes ₹11.80.
- **BiharCabs' share** = ride GST + commission + tech fee + 18% GST on (commission + tech fee). The formula is in `src/lib/fare-split.ts` and is used by every booking and by return-trip discounts. On a ₹2,500 ride at 3%: 119.05 + 75 + 10 + 15.30 = ₹219.35, and the driver keeps ₹2,280.65.
- **Customer invoice** (BiharCabs is the sole issuer): shows the taxable value and the GST included. Extra km/hour charges carry ride GST, which is added to the driver's share at settlement. Tolls/parking are passed through without GST.
- **Customer advance:** 18% GST is due when it is received (`advance_gst_pct`; the rate is not determinable at receipt, per CA). It is recorded on the payment link and booking, with a consecutive receipt voucher number (`RV<FY><serial>`).
- **Invalid or missing GST rates stop pricing** with an error; a rate never silently falls back to 0%.

Apply `crm-design/15_gst_on_rides_and_advances.sql` before deploying. Bookings created earlier keep their amounts (driver did not bear ride GST on those). Tests:
```bash
npx tsx --test src/tests/fare-split.test.ts
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/trip-otp.integration.ts
```

## WhatsApp templates (24-hour window)

Per Meta's Cloud API docs, WhatsApp delivers free-form text and interactive messages only within 24 hours of the recipient's last message to BiharCabs; outside that window only **approved template messages** are delivered.

- **`notify()`** (`src/lib/wa-notify.ts`) sends the rich message while the window is open (checked from `crm_whatsapp_logs`), and the approved template otherwise. Used for every message BiharCabs starts:
  - **drivers:** ride alerts, assignment, wake-up, dues, document notices, payouts;
  - **customers:** driver assigned + trip OTP, trip OTP, trip started, trip completed + rating, payment link, booking updates;
  - **admins:** alerts.
  
  Replies to someone who just messaged are always inside the window and stay free-form.
- **Template text** lives in `src/lib/wa-templates.ts`. **`crm-design/whatsapp_templates.md` is what to submit to Meta** (a test checks it matches the code). Approved names go in `crm_settings.whatsapp_templates`, with the language code under `language`. **Until a template is approved, that notification fails outside the window** and is logged as FAILED.
- **Template button taps** (Accept, Decline, Start Trip, I am ready, Pay dues, ratings) arrive with the button label and the template's message id. Each send is recorded in `crm_wa_template_sends` (migration 16), so the tap is mapped back to its booking and handled like the interactive button. Only the number the template went to can use it.
- **Drivers are alerted on every dispatch path:** the bot, staff "create and broadcast", the manual Broadcast button, payment confirmation and waivers. **Force-assign** now issues the trip OTP, tells the driver (with Start Trip) and tells the customer. If none of the offered drivers can be reached, admins are alerted at once.
- **Staff inbox** refuses a typed message outside the window (409) instead of failing silently.

Apply `crm-design/16_whatsapp_templates.sql` before deploying. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/wa-notify.integration.ts
```

## Driver dues payments

A negative `crm_drivers.wallet_balance` is what the driver owes BiharCabs. A payment writes a `DRIVER_DUES_PAYMENT` ledger entry and raises the wallet in one transaction, locked on the driver row.

- **Through the bot:** **Pay dues** sends a Razorpay link for exactly what is owed. An open link for the same amount is reused; a driver who owes nothing is told so. Only the signed `payment_link.paid` webhook records the payment, once per event, with the exact amount checked. A mismatch is not credited and admins are alerted. Dues carry no GST and no receipt voucher, because they settle commission already invoiced.
- **Recorded by finance:** **Finance → Drivers Owing Dues → Record payment**, or `POST /api/finance/dues-payments` with `{ driverId, amount, channel: UPI | BANK_TRANSFER | CASH, reference, notes? }`. Permission: `dues.record` (SUPER_ADMIN, FINANCE_MANAGER). A payment can't exceed what is owed, and a reference is accepted once per channel. The driver is notified.
- **Restriction lifted:** when the driver is back within their tier credit limit (the same rule that restricted them), `RESTRICTED_DIGITAL_ONLY` / `SUSPENDED_UNPAID_DUES` returns to `APPROVED_ACTIVE`. Other suspensions (documents, ratings) are never lifted here.

Apply `crm-design/17_driver_dues_payments.sql` before deploying (payment links can now belong to a driver's dues). Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/dues-payments.integration.ts
```

## Dispatch eligibility (one set of rules)

`src/lib/dispatch-engine.ts` defines the dispatch rules once, as columns of one query:
- **Status:** `APPROVED_ACTIVE`; on fully prepaid rides also `RESTRICTED_DIGITAL_ONLY`.
- **Availability:** the driver is marked available.
- **Rating:** at least `min_dispatch_rating`.
- **Licence:** not expired.
- **Vehicle:** a verified cab of the booking's type with valid insurance, fitness and permit.
- **Credit:** wallet + the shortfall of the driver's other open rides (`DRIVER_ASSIGNED`/`TRIP_IN_PROGRESS`) + this ride's shortfall (BiharCabs' share minus the advance held) must stay within the driver's tier credit limit. Fully prepaid rides are exempt, because they reduce what the driver owes.

These rules are applied at three points:
- **Broadcast** (`findEligibleDrivers`) offers the ride only to drivers who pass every rule, with one offer per driver.
- **Acceptance** (`acceptRideOffer`) checks the driver again with their row locked. A driver suspended, over the limit, or with expired documents since the offer is refused (`NOT_ELIGIBLE`, offer `INELIGIBLE`) and told why. Two rides accepted at once are both counted.
- **Force-assign** applies the same rules (base city excepted: staff choose the driver) and records the verified cab.
  - It only works on bookings waiting for a driver, or on `DRIVER_ASSIGNED` for a reassignment.
  - Trips in progress or completed are refused.
  - A reassignment issues a new trip OTP, closes pending offers and tells the previous driver.

Tests (a consistency test checks that broadcast and the single-driver check always agree):
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/dispatch-eligibility.integration.ts
```
