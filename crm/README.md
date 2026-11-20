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

The end-to-end return-trip test needs a disposable database whose name ends in `_test`, with the CRM schema, `crm_settings` and the migrations. It serves its own rate card, so it does not need WordPress:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/return-trips.integration.ts
```

## Deployment checklist (VPS)

Work through these in order. Each feature section below has the detail; this list is what a deployment needs.

### 1. Database (native PostgreSQL)
- [ ] **Back up first:** `pg_dump -Fc biharcabs_crm > biharcabs_crm_$(date +%F).dump`
- [ ] **See which migrations have run:** `SELECT version FROM crm_schema_migrations ORDER BY version;` (migrations 08 onwards record themselves).
- [ ] **Apply the missing ones in order**, up to **30**: `psql -v ON_ERROR_STOP=1 -d biharcabs_crm -f crm-design/NN_name.sql`. Each one from 08 on is safe to run again.
- [ ] **Migrations before code.** Apply them **before** the new code starts. From migration 26 on, the code writes to tables and columns the migrations add. Without 26, no GST document number can be issued, so **trip settlement and advance payments fail**. Without 27 and 28, settlement and payments fail on the new place-of-supply columns. Without 29, the document send step fails (other jobs carry on). Without 30, driver onboarding still works but the driver Status dialog fails.
- [ ] **Check the GST migrations:**
  - `SELECT * FROM crm_document_counters ORDER BY series, financial_year;` should show this year's `RV`, `RF` and `CC` counters at the last numbers already issued (migration 26). `TI` starts at 1.
  - `SELECT setting_value FROM crm_settings WHERE setting_key = 'cancellation_policy';` should show `cancellation_charge_gst_pct` 5.

### 2. Environment and code
`docker-compose.yml` passes these to the `crm` container from the root `.env` (never in git). After changing `.env`, recreate the container.
- [ ] `CRON_SECRET`: without it, both scheduled job endpoints refuse every call (503). Put the same value in n8n's **BiharCabs CRM cron secret** credential ([`../n8n/README.md`](../n8n/README.md)).
- [ ] `META_APP_SECRET`: verifies WhatsApp webhooks; without it every webhook event is rejected.
- [ ] `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: without the keys, advance payment links and refunds fail; without the webhook secret, payment webhooks are refused (503).
- [ ] `CLIENT_IP_HEADER` (optional): the header your reverse proxy sets with the client IP (e.g. `x-real-ip`). Without it, sign-in limits apply per email only, not per IP.
- [ ] **Database connection:** the container connects to host PostgreSQL (`host.docker.internal`) as the role `biharcabs_crm`, with the password `CRM_DB_PASSWORD` from the root `.env`. Compose refuses to start without it.
  - **Create the role once** per environment, as the owner of the CRM tables: `psql -v ON_ERROR_STOP=1 -d biharcabs_crm -v pw="$CRM_DB_PASSWORD" -f crm-design/crm_app_role.sql`. It can read and write data but not change the schema. Use a URL-safe password, e.g. `openssl rand -hex 24`. Running it again resets the password and re-applies the grants.
  - **Port 5432 must belong to the host PostgreSQL.** A Docker container that publishes `5432` on the host takes `host.docker.internal:5432`, and the CRM then reaches the wrong database: every sign-in and scheduled job fails with `password authentication failed`.
- [ ] `WP_API_BASE_URL` is only a fallback when the `biharcabs_wp_api` setting has no `base_url`.
- [ ] **Deploy the code:** `git pull`, then `docker compose up -d --build crm`. Rebuild with `--build`; restarting the old image isn't enough. The image must include `crm/next.config.js`, which keeps the PDF library outside the build. Without it every GST document PDF fails (500, `Helvetica.afm` not found), both downloads and WhatsApp sends.

### 3. External services
- [ ] **Razorpay webhook** to `https://<crm host>/api/payments/razorpay/webhook`, secret = `RAZORPAY_WEBHOOK_SECRET`, events: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `refund.processed`, `refund.failed`.
- [ ] **Meta WhatsApp webhook** to `https://<crm host>/api/whatsapp/webhook`, with the verify token from the `meta_whatsapp_config` setting.
- [ ] **WhatsApp templates:** submit the 14 templates in [`crm-design/whatsapp_templates.md`](../crm-design/whatsapp_templates.md) to Meta, then put the approved names in the `whatsapp_templates` setting. Until a template is approved, that message fails outside the 24-hour window (it shows under **Failed messages** on the dispatch board). `bc_customer_gst_document` needs a **Document** header; upload any sample PDF when submitting it.
- [ ] **Rotate the Meta access token** if any deployed CRM ran code from before 3e3e0e9: until then a request with any cookie value could read the settings, token included. Save the new one in `meta_whatsapp_config`.
- [ ] **WordPress rate card:** fare quotes must be switched on (`public_enabled`). It ships switched off, and then the WhatsApp bot cannot price rides and staff bookings cannot use the rate card.
- [ ] **n8n:** both workflows active (every 5 minutes, and daily at 09:00 IST).

### 4. Settings (`/settings` or `crm_settings`)
- [ ] `company_billing_info.gstin`: BiharCabs' GSTIN. Without it no GST document PDF is produced and none is sent to customers; they wait, and go out once it is set. Its first two digits must match `state_code` (10, Bihar).
- [ ] `place_of_supply_cities`: every city rides start from, with its GST state code. Migration 27 lists Patna, Darbhanga, Gaya and Muzaffarpur; invoices for other cities wait on the Finance page until finance chooses the state.
- [ ] `admin_escalation_contacts`: at least one admin phone. Every admin alert (SLA, unconfirmed wake-ups, failed messages, OTP lockouts) goes here.
- [ ] `cancellation_policy.cancellation_charge_gst_pct`: **5%** per the CA, set by migration 26 if it was empty. The cancellation charge documents waiting for it are issued by the next daily job.
- [ ] Check the defaults the migrations set are what you want: `advance_collection_policy`, `revenue_protection_policy.streak_min_fare` (₹700), `driver_wakeup_unconfirmed_alert_minutes` (60), `driver_ride_gap_hours` (4), `gst_document_delivery.max_attempts` (3).

### 5. Accounts and data
- [ ] **Old seeded admin:** if any CRM still has `admin@biharcabs.com` with the password once published in this repository, reset it: `CRM_ADMIN_EMAIL=admin@biharcabs.com node scripts/set-admin-password.mjs` (from `crm`).
- [ ] **Advances never verified:** bookings marked `advance_status = 'LEGACY_UNVERIFIED'` by migration 11 carry an advance nobody confirmed. Check each before it is settled.
- [ ] **Double-booked rides:** `psql -d biharcabs_crm -f crm/scripts/check-double-booked-rides.sql` lists drivers holding rides less than 4 hours apart. Reassign one ride of each pair.
- [ ] **Documents waiting for a place of supply:** migrations 27 and 28 fill in existing ride invoices, receipt vouchers, refund vouchers and cancellation charges. Those whose pickup city isn't listed, or whose customer GSTIN is malformed, are listed under **Finance → GST Documents Waiting for Place of Supply**. Choose each one's state there. List the cities first, so fewer need choosing.
- [ ] **Excess GST to reclaim:** **Finance → Excess GST to Reclaim (Form GST RFD-01)** shows, by month, the 18% paid on advances later kept at 5%. Give it to the CA to file. Charges marked "unknown" have no GST recorded on their receipt voucher; check them with the CA.
- [ ] **Drivers with made-up document dates:** before this release the CRM onboarding form saved licence expiry 2028-12-31 and insurance, fitness and permit expiry 2027-12-31 for every driver, whatever their documents said. List them with `SELECT d.id, d.full_name, d.phone, v.registration_no FROM crm_drivers d JOIN crm_driver_vehicles v ON v.driver_id = d.id WHERE d.license_expiry = '2028-12-31' AND v.insurance_expiry = '2027-12-31' AND v.fitness_expiry = '2027-12-31' AND v.permit_expiry = '2027-12-31';` and enter the real dates from each driver's documents.
- [ ] **Older documents:** everything issued before migration 29 is `NOT_SENT` and is never sent automatically. If a customer asks for one, search its booking code under **Finance → GST Documents**, download the PDF and send it.

### 6. Tell drivers
- [ ] **GST:** drivers now bear the 5% ride GST, and pay 18% GST on commission plus the tech fee (₹10 becomes ₹11.80). See [GST](#gst-per-biharcabs-ca).
- [ ] **Streak bonus:** only rides of at least ₹700 count, and every driver's streak starts again from 0.
- [ ] **Rides:** a driver can no longer hold two rides whose pickups are less than 4 hours apart.
- [ ] **Joining:** drivers who join on WhatsApp now wait for BiharCabs to check their documents before they get ride offers.

### 6b. Tell finance and the CA
- [ ] **New ride invoice series:** from the deploy, ride invoices are numbered `TI<financial year><6 digits>` (e.g. `TI2627000001`), one running series. Earlier invoices keep their `INV-…` numbers. Report both series in GSTR-1 Table 13 for this year.
- [ ] **Yearly restart:** every series (`TI`, `RV`, `RF`, `CC`) restarts at 000001 on 1 April.
- [ ] **Tax split:** invoices and vouchers now show CGST + SGST within Bihar, or IGST for other states, by place of supply.
- [ ] **Finance summary cards:**
  - **Completed rides only:** Facilitation, GST on Rides and Tech Fees now count only completed rides, not rides that are only assigned or in progress. Expect those totals to be **lower** than before the deploy. They no longer move as rides are assigned or cancelled.
  - **GST card:** the old "Statutory 18% GST" card is now **GST on Rides**. It shows its two parts: 5% ride GST (Sec 9(5)), and 18% on commission and the tech fee.

### 6c. Tell staff
- [ ] **Phones:** the CRM now works on a phone. Tap the menu button (top left) to open the menu.
- [ ] **Status pills:**
  - **WhatsApp pill** (top bar; inside the menu on phones):
    - **green** "configured";
    - **amber** "sends failing": every send in the last hour failed, so check **Failed messages**;
    - **red** "not configured": nothing is being sent.
  - **Database pill** (sidebar): shows whether the CRM can reach its database.
  - **Hovering a pill** shows the details.
- [ ] **New drivers start as Pending:** a driver added on **Drivers** or through WhatsApp gets no rides until someone checks their documents and presses **Review → Activate**. See [Driver status](#driver-status-activate-suspend-offboard).

### 7. After deploying
- [ ] Sign in, and check the dispatch board loads.
- [ ] **Status pills:** the sidebar should show **Database connected**, and the top bar **WhatsApp configured**.
  - **Red "WhatsApp not configured":** the Meta access token or phone number id is missing in `meta_whatsapp_config`. Every message is only simulated until it is set.
  - **Amber "WhatsApp sends failing":** check **Failed messages** for Meta's error, which is often an expired token.
- [ ] Run the frequent job once: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<crm host>/api/dispatch/cron`. It should return `success: true` with a count per job (`cronResults`); then check n8n's Executions list shows it succeeding.
- [ ] Send a WhatsApp message to the business number and check it appears in the staff inbox.
- [ ] **First GST documents:**
  - After the first trip settles, check its invoice number is `TI<FY>000001`, or the next one.
  - Download its PDF under **Finance → GST Documents** (search the booking code), and check the GSTIN, the place of supply and the CGST/SGST or IGST lines. A "Could not produce the PDF" error means the image was built without `next.config.js` (see step 2).
- [ ] **First document on WhatsApp outside the 24-hour window:** check the customer received the template **with the PDF attached**. The send format for a document header is the one part not confirmed against Meta's docs. If it fails, it shows under **Failed messages** after 3 tries, with Meta's error.

---

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

- **`POST /api/dispatch/cron`, every 5 minutes:** return-trip windows, SLA escalation, driver wake-up checks and alerts for unconfirmed ones, expired-document suspension, unpaid-dues restriction, payment links whose expiry webhook never arrived, the failed-message summary. Each job changes a status or records a sent time, so repeated runs do not repeat messages.
- **`POST /api/dispatch/cron/daily`, 09:00 IST:** reminders to drivers whose documents expire within 15 days, purging old sign-in attempts, and cancellation charge documents. Nothing records who was reminded, so this must not run more than once a day.

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

## Driver status (activate, suspend, offboard)

New drivers, from **Drivers → Onboard New Driver** or WhatsApp "JOIN", start as `PENDING_DOCS` with unverified vehicles, and get no rides. Signing up again on WhatsApp never changes an existing driver's status, and leaves a registration number already on file as it is. The CRM form refuses a registration number that belongs to another driver (409) and saves nothing.

Staff change a driver's status on **Drivers → Status** (or **Review** for a pending driver), or `POST /api/drivers/[id]/status` with `{ action, reason, license_expiry?, vehicles?: [{ id, insurance_expiry, fitness_expiry, permit_expiry }] }`. Permission: `drivers.manage` (SUPER_ADMIN, DISPATCHER). `GET` on the same path returns the status, document dates and history (`drivers.view`).

| Action | From | To |
|---|---|---|
| `ACTIVATE` | `PENDING_DOCS`, `SUSPENDED_DOC_EXPIRED`, `SUSPENDED_QUALITY`, `SUSPENDED_MANUAL`, `OFFBOARDED` | `APPROVED_ACTIVE` |
| `SUSPEND` | any status except `SUSPENDED_MANUAL`, `OFFBOARDED` | `SUSPENDED_MANUAL` |
| `OFFBOARD` | any status except `OFFBOARDED` | `OFFBOARDED` |

- Every change needs a reason (5-500 characters) and is recorded in `crm_driver_status_changes` with the admin, in the same transaction.
- **Activate** saves any dates sent, then is refused (422, nothing saved) unless the licence and every vehicle's insurance, fitness and permit dates are entered and not past, and the driver has a vehicle. It marks the driver's vehicles verified and available.
- Drivers restricted for unpaid dues (`RESTRICTED_DIGITAL_ONLY`, `SUSPENDED_UNPAID_DUES`) cannot be activated by hand; paying the dues restores them, as before.
- Suspend and offboard take the driver off rides (`is_available = false`). A ride the driver already holds is not cancelled; reassign it if needed.
- The driver is not messaged about any of these changes.
- Automatic status changes (expired documents, ratings, dues) are not recorded in `crm_driver_status_changes`.

Apply `crm-design/30_driver_status_changes.sql` before deploying. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/driver-status.integration.ts
npx tsx --test src/tests/driver-status.test.ts src/tests/driver-onboarding.test.ts
```

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

## Booking codes

Customer-facing codes are `BC-` + 6 characters from an alphabet without look-alikes (no 0/O/1/I), drawn with `crypto`. That is about 1.07 billion values, and they can't be guessed or used to count bookings. Inserts retry with a new code on the rare collision (`src/lib/booking-code.ts`). The old 4-digit codes (9,000 values in a unique column) made inserts fail more often as bookings accumulated. Existing codes are unchanged.

## Cancellations and refunds

**Policy** (`cancellation_policy.free_cancellation_hours`, 2):
- Customer cancels 2+ hours before pickup: the online advance is refunded in full.
- Customer cancels later: no refund; BiharCabs keeps the advance, even if a driver was assigned.
- BiharCabs cancels (no driver, driver no-show, operational): full refund at any time.

**Who can cancel:**
- **Customers:** reply **CANCEL** on WhatsApp. They see their next booking and exactly what they would get back, then confirm with **Yes, cancel** or **Keep booking**. The refund is decided at the moment they confirm. A trip already started is sent to support.
- **Staff:** **Cancel** on the dispatch board (`bookings.cancel`: all roles), choosing the fault and giving a reason. The refund outcome is shown before confirming. `POST /api/bookings/{id}/cancel` with `{ fault: CUSTOMER | BIHARCABS, reason }`.

**When a booking is cancelled:**
- An unpaid advance link is closed at Razorpay first.
- The booking becomes `CANCELLED`, recording who cancelled, the fault, the reason, the amount refunded and the amount kept.
- Pending offers close, and the trip OTP is cleared.
- The customer and any assigned driver are told.
- A cancelled booking can't be broadcast again. Broadcasting is now allowed only while a booking waits for a driver.

**Refunds** (`crm_refunds`, one per booking) go to the original Razorpay payment (`POST /v1/payments/{id}/refund`):
- Each refund is claimed (`SUBMITTING`) before Razorpay is called, so it can never be sent twice.
- It is booked to the ledger (`CUSTOMER_ADVANCE_REFUND`) when Razorpay reports it processed: at once, or by the `refund.processed` webhook.
- `refund.failed`, or a failed request, leaves it `FAILED`. Finance retries it from **Finance → Refunds In Progress** (`refunds.manage`).
- A refund stuck in `SUBMITTING` must be checked in the Razorpay dashboard first.

Add **`refund.processed`** and **`refund.failed`** to the Razorpay webhook, and apply `crm-design/18_cancellations_refunds.sql`. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/cancellations.integration.ts
```

## GST documents for refunds and cancellation charges (per CA)

Every GST document is numbered in its own consecutive series (`src/lib/gst-documents.ts`, per CA and Rule 46(b) of the CGST Rules):
- **Series:** `TI` ride tax invoice, `RV` receipt voucher, `RF` refund voucher, `CC` cancellation charge.
- **Format:** the series, the financial year, then a 6-digit serial, e.g. `TI2627000001`. That's 12 characters; the rule allows at most 16.
- **Yearly restart:** each series starts again at **000001 on 1 April** (India time), so a year's first and last serials match the documents reported in GSTR-1 Table 13.
- **No gaps:** numbers come from `crm_document_counters` (migration 26), one row per series per year. They're issued inside the transaction that saves the document, so a failed transaction gives its number back.
- **Earlier ride invoices** keep their old `INV-…` numbers. A booking keeps its first `TI` number if its invoice is ever rewritten.

- **Refunded advance:** the advance was covered by a receipt voucher, not a tax invoice, so a credit note isn't valid. When Razorpay reports the refund processed, a **refund voucher** (`RF…`) is issued on `crm_refunds`. It quotes the receipt voucher's number and date and records the GST it reverses. Credit notes (Section 34) apply only where a tax invoice was issued upfront, such as driver plans, which are non-refundable.
- **Kept advance on a late cancellation:** a taxable cancellation charge. It is recorded in `crm_cancellation_charges` at once, linked to its receipt voucher. Its tax document (`CC…`, GST included in the kept amount) is issued at `cancellation_policy.cancellation_charge_gst_pct`: **5%**, the rate of the ride itself (per CA, CBIC Circular No. 178/10/2022-GST). Without a rate, documents wait and are issued at the next cancellation or by the daily job once it is set.
- **Excess GST on a kept advance:** the advance was taxed at 18% when received, and the charge it becomes at 5%. Per the CA, the difference **cannot be adjusted in GSTR-3B**. It is reclaimed with **Form GST RFD-01**, "Refund of excess payment of tax" (Section 54, CGST Act). Each issued charge records `advance_gst_paid` (on the part kept) and `excess_gst`. **Finance → Excess GST to Reclaim** totals them by month for the claim. Where the receipt voucher has no GST recorded, nothing is guessed: the charge is counted as "unknown". Finance → Refunds shows how many are waiting. An invalid rate stops these documents but not the other daily jobs.

Apply `crm-design/19_refund_vouchers_cancellation_charges.sql` and `crm-design/26_gst_document_numbering.sql` before deploying. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/gst-numbering.integration.ts
```

## Staff booking fares

Bookings created by staff (`POST /api/bookings`) are priced on the server from the **same WordPress rate card the WhatsApp bot uses** (`src/lib/staff-fare.ts`), for the route and cab type. The distance also comes from the rate card. The fare sent by the form is not trusted.

- **Dispatchers** book at the rate-card fare. Leaving the fare empty, or typing the rate-card fare, are both fine. A different fare is refused (403). If the route isn't priced (`NO_TARIFF` / `OUT_OF_SERVICE_AREA`) or the rate card can't be reached, the dispatcher is told to ask the super admin (409).
- **The super admin** (`bookings.override_fare`) may book a different fare for an unlisted route or a negotiated price, with a reason. The booking keeps `fare_source = OVERRIDE`, the rate-card fare (if any), who changed it and why.
- **Any fare** that leaves the driver nothing after BiharCabs' share and GST is refused.

Apply `crm-design/20_staff_booking_fares.sql` before deploying. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/staff-fare.integration.ts
```

## Ride streak bonus

`streak_bonus_amount` (₹150) is paid on every `streak_bonus_target_trips`-th (5th) **qualifying** trip.

- **Qualifying trip:** a completed trip whose booked fare is at least `revenue_protection_policy.streak_min_fare` (₹700, just above break-even, so five qualifying trips always earn BiharCabs at least the bonus).
- **Two counters:** qualifying trips have their own counter (`crm_drivers.streak_qualifying_trips`), so small trips neither count toward the streak nor complete it. `total_trips_completed` still counts every trip, for credit tiers.
- **Missing setting:** if `streak_min_fare` is missing or invalid, no bonus is paid.

Apply `crm-design/21_streak_bonus_min_fare.sql`; counters start at 0 for every driver. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/streak-bonus.integration.ts
```

## Payment links whose expiry webhook never arrived

A booking waiting for its advance used to close only on Razorpay's `payment_link.expired` webhook. If that webhook was lost, the booking stayed `AWAITING_ADVANCE` forever. The frequent job (every 5 minutes) now checks links still `CREATED` more than 10 minutes after `expire_by` (`reconcileStalePaymentLinks` in `src/lib/advance-payments.ts`, `GET /v1/payment_links/{id}`):

- **Expired or cancelled at Razorpay:** the link is closed exactly as the webhook would close it. An advance booking becomes `ADVANCE_EXPIRED` and the customer is told; a dues link just closes. A late webhook then changes nothing.
- **Paid at Razorpay, but no confirmation received:** nothing is credited, because only the signed webhook confirms money. Admins are alerted once (`reconcile_alerted_at`), and the link isn't checked again.
- **Still open at Razorpay, or Razorpay unreachable:** left for the next run. A Razorpay failure doesn't stop the other jobs.

Apply `crm-design/22_reconcile_payment_links.sql`. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/reconcile-links.integration.ts
```

## Driver wake-up check and follow-up

- **Reminder:** `driver_wakeup_check_hours_before` (2) hours before pickup, the assigned driver gets the wake-up check. Pickup times are India local and compared as full timestamps, so there's no midnight wrap and no dependence on the database time zone. No reminder is sent for a pickup already past.
- **Confirmation:** "I am ready" (button, template button, or typing `ready`) records `wakeup_confirmed_at` on the driver's own assigned trip: the one tapped, or the next upcoming one.
- **Follow-up:** if an assigned driver hasn't confirmed by `driver_wakeup_unconfirmed_alert_minutes` (**60**) before pickup, admins are alerted **once** (`wakeup_alerted_at`) with the driver's name and phone, so they can call or reassign. The alert waits at least 15 minutes after the reminder went out, so a late-assigned driver has a chance to answer. An invalid setting falls back to 60.

Apply `crm-design/23_wakeup_confirmation.sql`. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/wakeup.integration.ts
```

## Restoring drivers restricted for dues

A driver is restricted (`RESTRICTED_DIGITAL_ONLY`, or `SUSPENDED_UNPAID_DUES` when soft mode is off) once their wallet is past `-` their **tier credit limit** (probation ₹300, standard ₹1,000, elite ₹2,500; `dynamic_credit_limits`).

The same limit restores them, wherever their wallet improves:
- trip settlement;
- incentive payments;
- dues payments (`creditLimitFor` in `src/lib/driver-dues.ts`).

A restored driver is also made available again. Trip settlement and incentives used to restore at a hardcoded −₹300 whatever the tier. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/restore-threshold.integration.ts
```

## Failed WhatsApp messages

Every message BiharCabs starts goes through `notify()` (`src/lib/wa-notify.ts`). A send that fails, or raises an error, is recorded in `crm_notification_failures`, on both the template and the free-form path. That includes a template with no approved name configured, which used to reach only the server console. The caller still gets the same result or error as before.

- **What is kept:** which message it was, the phone, the booking code where the template has one, and the error.
- **What is not kept:** the message contents. Some carry the customer's trip OTP, so there is **no automatic resend**. A customer can reply `OTP` for a new code.
- **Admin summary:** the 5-minute job sends **one** admin alert listing what didn't arrive: up to 5 lines, plus a count of the rest. Each failure is reported once (`alerted_at`). Failed admin alerts are never reported, since the summary is itself an admin alert and could loop. Failures already handled aren't reported either.
- **Dispatch board:** a **Failed messages** list shows while anything is open. Staff call the person, then press **Mark handled**, which records `resolved_by`. Any role can view it (`bookings.view`) and mark failures handled (`notifications.resolve`).
- **API:** `GET /api/notifications/failures` lists the newest 100 open failures with the open count; `POST /api/notifications/failures/[id]/resolve` marks one handled (409 if already handled).

Apply `crm-design/24_notification_failures.sql`. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/notification-failures.integration.ts
```

## Minimum gap between a driver's rides

A driver can't hold two rides whose pickups are less than `driver_ride_gap_hours` (**4**) apart, before or after. "Holding" means a ride that is `DRIVER_ASSIGNED` or `TRIP_IN_PROGRESS`. Bookings store a pickup time but no end time, so the rule is a fixed gap rather than an estimated trip end.

- **Where it applies:** the rule is part of the one set of dispatch rules (`schedule_ok` in `eligibilityRows`, `src/lib/dispatch-engine.ts`), so it applies at broadcast, when a driver accepts, and when staff assign.
- **No staff override:** staff free the driver first by reassigning the other ride.
- **Refusals name the clashing booking,** for example "already has ride #BC-… with a pickup less than 4 hours from this one".
- **Pickup comparison:** pickups are compared as full India-time timestamps, so the gap works across midnight. Exactly 4 hours apart is allowed. A ride being reassigned isn't counted against itself.
- **Invalid setting:** anything that isn't more than 0 and at most 24 hours falls back to 4, so a wrong setting can't let a driver be double-booked.

Apply `crm-design/25_driver_ride_gap.sql`. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/ride-gap.integration.ts
```

## Place of supply and CGST/SGST/IGST (per CA)

A ride invoice shows its 5% GST split by place of supply (Rule 46, CGST Rules), not as one "tax" figure:
- **Within BiharCabs' state:** 2.5% CGST + 2.5% SGST.
- **Otherwise:** 5% IGST.

The rules are in `src/lib/place-of-supply.ts`.

- **Place of supply** (Section 12(9), IGST Act):
  - **Registered customer:** the state in their GSTIN (its first two digits).
  - **Anyone else:** the state where the passenger is picked up, looked up in the `place_of_supply_cities` setting (city in lowercase → GST state code).
- **BiharCabs' state:** from its GSTIN once set, otherwise `company_billing_info.state_code` (10, Bihar). If they disagree, invoices wait rather than guess.
- **Every GST document carries it** (migration 28):
  - **Ride invoice (`TI`) and receipt voucher (`RV`):** worked out when issued.
  - **Refund voucher (`RF`):** takes the place of supply of the receipt voucher it reverses.
  - **Cancellation charge (`CC`):** takes its receipt voucher's; it's worked out on its own only when there is no receipt voucher.
  - **Receipt vouchers** also record the rate they were issued at (`gst_pct`, 18%), so they split as 9% + 9% or 18% IGST.
- **Nothing is guessed.** A pickup city not in the list, or a malformed customer GSTIN, still lets the money move and the document be numbered.
  - **The document waits** under **Finance → GST Documents Waiting for Place of Supply**. Finance chooses the state there (`gst_documents.manage`: super admin and finance), and can tick **Remember** to add the city for later rides.
  - **A receipt voucher's refund and cancellation documents follow it** when its state is chosen.
  - **Nothing is overwritten:** a city already listed, or a place of supply once set, is never changed.
- **State codes** come from the GST e-invoice portal's master list (`src/lib/gst-states.ts`).
- **PDFs** (`src/lib/gst-pdf.ts`): tax invoice (Rule 46), receipt voucher (Rule 50), refund voucher (Rule 51) and cancellation-charge tax invoice.
  - **What they show:** BiharCabs' and the customer's details, the number and date, the place of supply, the SAC, the CGST + SGST or IGST lines, "Tax payable on reverse charge: No", and an "Authorised signatory" line. Refund and cancellation documents quote their receipt voucher.
  - **When they're refused:** while BiharCabs' GSTIN or the place of supply is missing.
  - **Amounts print as "Rs.":** the built-in PDF fonts have no rupee sign.
  - **Download:** **Finance → GST Documents** lists the documents WhatsApp could not deliver. It finds any document by booking code or document number (exact match), and each has a **Download PDF** button. A PDF that can't be made yet shows the reason instead of downloading. API: `GET /api/finance/gst-documents?q=` and `GET /api/finance/gst-documents/[kind]/[id]/pdf` (both `ledger.view`).
  - **Also sent:** customers get them on WhatsApp (see below).
- **Confirmed by the CA:** an "Authorised signatory" line is enough as the signature, and "Tax payable on reverse charge: No" is correct for rides taxed under Section 9(5).
- **Existing documents** are filled in by migrations 27 and 28, by the same rules.

Apply `crm-design/27_gst_place_of_supply.sql` and `crm-design/28_gst_voucher_place_of_supply.sql`. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/place-of-supply.integration.ts src/tests/gst-document-pdfs.integration.ts
```

## GST documents on WhatsApp (per CA)

Customers must be given their tax invoices, receipt vouchers, refund vouchers and cancellation charge invoices (Section 31, CGST Act). The 5-minute job sends each one as a PDF (`src/lib/gst-delivery.ts`):
- **How:** the PDF is uploaded to Meta and sent by media id, never by a public link.
  - **Inside the 24-hour window:** a document message with a caption.
  - **Outside it:** the `customer_gst_document` template, with the PDF in its document header.
- **Unverified:** the send-time format for a template's document header. Meta's docs show image headers and document messages, and the CRM follows both. Confirm it on the first live send.
- **Waiting:** a document waits, using no attempt, while BiharCabs' GSTIN or its place of supply is missing. It is sent once they are set.
- **Failures:**
  - **Retries:** a failed upload or send is retried on later runs, up to `gst_document_delivery.max_attempts` (3).
  - **After the last try:** the document is marked `FAILED` and listed **once** under **Failed messages**. It also appears under **Finance → GST Documents**, where finance downloads the PDF and sends it by hand.
- **Delivery status on each document:** `wa_delivery_status` is `PENDING`, `SENT`, `FAILED` or `NOT_SENT`. Each document also records `wa_sent_at`, `wa_attempts` and `wa_last_error`.
- **Older documents:** documents issued before migration 29 are `NOT_SENT` and are never sent automatically (owner decision). Finance can find and download them under **Finance → GST Documents**.
- **Duplicates:** a document is locked while it is sent, so it is sent once. If the server stops after WhatsApp accepted it but before that was saved, the customer may get a second copy, never none.

Apply `crm-design/29_gst_document_delivery.sql`, and submit the `bc_customer_gst_document` template (document header) to Meta. Tests:
```bash
DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/gst-delivery.integration.ts
```
