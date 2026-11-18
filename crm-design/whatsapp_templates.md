# WhatsApp templates to submit to Meta

Generated from `crm/src/lib/wa-templates.ts`; keep the two in sync (a test checks this file).

**Why:** WhatsApp delivers free-form messages only within 24 hours of the recipient's last message to BiharCabs. Outside that window the CRM sends these templates instead. Until a template is **approved**, that notification fails outside the window. Each failure is logged in `crm_whatsapp_logs`.

**How to submit:** in WhatsApp Manager → Message templates → Create template:
- **Category:** Utility.
- **Language:** English (`en`). If Meta assigns a different code, such as `en_US`, set `whatsapp_templates.language` in crm_settings to match.
- **Name and body:** exactly as below.
- **Buttons:** add the quick-reply buttons with exactly these labels. The CRM matches taps on the label.
- **Sample values:** Meta asks for a sample for each {{n}}. Use realistic values, e.g. `#BC-1042`, `Patna to Gaya`, `₹2,250`.

If Meta approves a template under a different name, put that name in `crm_settings.whatsapp_templates` under the key shown.

## bc_driver_ride_alert  
**Settings key:** `driver_ride_alert` · **Category:** UTILITY

```
New BiharCabs ride {{1}}: {{2}}, pickup {{3}}, cab {{4}}. Collect cash at drop: {{5}}. Your earnings: {{6}}. The first driver to accept gets the ride.
```

- {{1}}: booking code
- {{2}}: route
- {{3}}: pickup date and time
- {{4}}: cab type
- {{5}}: cash to collect
- {{6}}: driver earnings

**Quick-reply buttons:** `Accept`, `Decline`

## bc_driver_trip_assigned  
**Settings key:** `driver_trip_assigned` · **Category:** UTILITY

```
BiharCabs has assigned you ride {{1}}: pickup at {{2}} on {{3}}. Customer: {{4}}. Collect cash at drop: {{5}}. At pickup, tap Start Trip and enter the customer's OTP.
```

- {{1}}: booking code
- {{2}}: pickup address
- {{3}}: pickup date and time
- {{4}}: customer name and phone
- {{5}}: cash to collect

**Quick-reply buttons:** `Start Trip`

## bc_driver_wakeup_check  
**Settings key:** `driver_wakeup` · **Category:** UTILITY

```
Reminder: BiharCabs pickup {{1}} on {{2}} at {{3}}. Please confirm you will be on time.
```

- {{1}}: booking code
- {{2}}: pickup date and time
- {{3}}: pickup address

**Quick-reply buttons:** `I am ready`

## bc_driver_dues_reminder  
**Settings key:** `driver_dues_reminder` · **Category:** UTILITY

```
Your BiharCabs dues are {{1}}, above your credit limit of {{2}}. {{3}} Tap below to pay.
```

- {{1}}: amount due
- {{2}}: credit limit
- {{3}}: what happens to rides until paid

**Quick-reply buttons:** `Pay dues`

## bc_driver_account_notice  
**Settings key:** `driver_account_notice` · **Category:** UTILITY

```
BiharCabs account update: {{1}}
```

- {{1}}: notice (documents expiring or expired, account status)

## bc_driver_payout_sent  
**Settings key:** `driver_payout_sent` · **Category:** UTILITY

```
BiharCabs paid you {{1}} by {{2}} (reference {{3}}). Amount still owed to you: {{4}}.
```

- {{1}}: amount paid
- {{2}}: payment method
- {{3}}: reference
- {{4}}: amount still owed

## bc_customer_driver_assigned  
**Settings key:** `customer_driver_assigned` · **Category:** UTILITY

```
Your BiharCabs booking {{1}} is confirmed. Driver: {{2}}, phone {{3}}, cab {{4}}. Pickup at {{5}} on {{6}}. Pay the driver {{7}} at drop. Your trip OTP is {{8}}: share it with the driver only when you are in the cab.
```

- {{1}}: booking code
- {{2}}: driver name
- {{3}}: driver phone
- {{4}}: cab type
- {{5}}: pickup address
- {{6}}: pickup date and time
- {{7}}: cash payable to driver
- {{8}}: trip OTP

## bc_customer_trip_otp  
**Settings key:** `customer_trip_otp` · **Category:** UTILITY

```
Your trip OTP for BiharCabs booking {{1}} is {{2}}. Share it with the driver only when you are in the cab.
```

- {{1}}: booking code
- {{2}}: trip OTP

## bc_customer_trip_started  
**Settings key:** `customer_trip_started` · **Category:** UTILITY

```
Your BiharCabs trip {{1}} has started. Have a safe journey.
```

- {{1}}: booking code

## bc_customer_trip_completed  
**Settings key:** `customer_trip_completed` · **Category:** UTILITY

```
Thank you for riding with BiharCabs. Trip {{1}} is complete. Total: {{2}}. Invoice: {{3}}. How was your driver?
```

- {{1}}: booking code
- {{2}}: total amount
- {{3}}: invoice number

**Quick-reply buttons:** `5 stars`, `4 stars`, `3 stars or less`

## bc_customer_payment_link  
**Settings key:** `customer_payment_link` · **Category:** UTILITY

```
Pay the {{1}} advance to confirm BiharCabs booking {{2}}: {{3}} . The link is valid for {{4}} minutes. Balance payable to the driver at drop: {{5}}.
```

- {{1}}: advance amount
- {{2}}: booking code
- {{3}}: payment link
- {{4}}: minutes valid
- {{5}}: balance payable to driver

## bc_customer_booking_update  
**Settings key:** `customer_booking_update` · **Category:** UTILITY

```
BiharCabs booking {{1}}: {{2}}
```

- {{1}}: booking code
- {{2}}: update (advance received, not confirmed, confirmed without advance)

## bc_admin_alert  
**Settings key:** `admin_alert` · **Category:** UTILITY

```
BiharCabs operations alert: {{1}}
```

- {{1}}: alert

