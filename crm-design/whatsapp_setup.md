# Setting up Meta WhatsApp for the BiharCabs CRM

Step-by-step setup of the WhatsApp Business Platform (Cloud API) for the CRM: Meta app, phone number, permanent token, webhook, templates, and where each value goes in the CRM. Template wording is in [whatsapp_templates.md](whatsapp_templates.md).

Checked against Meta's official developer documentation on **21 November 2026** (sources at the end). Meta changes these screens often. If a screen looks different, follow Meta's current wording; the values you need stay the same. Anything Meta's docs did not confirm is marked **Unverified**.

---

## 0. Decide before you start

1. **Which phone number.** Meta: *"Numbers already in use with WhatsApp cannot be registered unless they are deleted first."*
   - If the number is on the WhatsApp or WhatsApp Business **app** (for example the support number +91 7070992170 used in the bot's messages), registering it here means deleting it from the app first. Its app chats stay on the phone, but the app can no longer use that number.
   - Meta offers "coexistence" (app and Cloud API on one number), but only through Embedded Signup, a partner flow. **Unverified** for a business setting up its own app; this guide does not cover it.
   - The number must be yours, have a country code (no short codes), and be able to receive an SMS or voice call for verification.
   - **Recommended:** a dedicated number for the CRM, so your current app number keeps working while you set up and test.
2. **A business portfolio** (Meta Business Manager) owned by the company. Everything below sits inside it.
3. **Business verification** of the portfolio, done in Business Settings. The exact steps are in Meta's Help Center; the developer pages read only link to it. Not required to start, but without it you are limited to **250 unique people per 24 hours** outside the 24-hour window (see §8). That limit is shared across ride alerts to drivers and messages to customers.
4. **A payment method** on the WhatsApp account (see §8). Template messages are charged, and from 1 October 2026 so are utility messages and service messages above the free tier.

## 1. Create the Meta app

1. Go to https://developers.facebook.com/apps → **Create App**.
2. App name (e.g. `BiharCabs CRM`) and contact email.
3. Use case: **Connect with customers through WhatsApp** → Next.
4. Select the company's **business portfolio** → **Create app**.
5. You land on **Customize use case → Connect on WhatsApp → Quickstart**. Click **Start using the API**.

## 2. Connect a WhatsApp Business Account (WABA)

1. On **API Setup**, choose your messaging account from the dropdown, or **Create a WhatsApp Business account**.
2. Note the **WhatsApp Business Account ID** ("Messaging account ID"). → CRM `business_account_id`.
3. Meta gives you a **test number** and a temporary token on this page. You can use them to send yourself a test message. Do not configure the CRM with them: the temporary token *"expires quickly and is not suitable for development purposes"*. The test number's recipient limit is **Unverified** (not stated on the pages read).

## 3. Add and register the real number

1. In **WhatsApp Manager** (business.facebook.com → WhatsApp Manager), first **accept the Terms of Service** in the banner. Meta: *"Registration calls will fail until you accept the Terms of Service."*
2. **Add phone number**, then enter the **display name** (e.g. `BiharCabs`) and verify the number by SMS or voice call.
   - Display name: required when registering. Meta reviews it automatically when your messaging limit rises. You can change it at most 10 times in 30 days, and must re-register after an approved change.
3. Note the number's **Phone number ID** (WhatsApp Manager → Phone numbers, or `GET /<WABA_ID>/phone_numbers`). → CRM `phone_number_id`.
4. **Register** the number for Cloud API and set its **two-step verification PIN**. This is required: *"Setting up two-step verification is a requirement to use the Cloud API."* Choose your own 6-digit PIN and keep it in your password manager.

   ```bash
   curl -X POST "https://graph.facebook.com/v26.0/<PHONE_NUMBER_ID>/register" \
     -H "Authorization: Bearer <PERMANENT_TOKEN>" -H "Content-Type: application/json" \
     -d '{"messaging_product": "whatsapp", "pin": "<YOUR_6_DIGIT_PIN>"}'
   # expect {"success": true}
   ```

   Run this after §4, since it needs the permanent token.

## 4. Permanent access token (system user)

1. **Business Settings** (business.facebook.com/latest/settings) → **Users → System users** → **Add**. Name it `biharcabs-crm`.
   - Meta's page doesn't say whether the system user should be Admin or Employee. **Employee** with the asset access below should be enough (least privilege); use Admin only if token generation refuses.
2. Select the system user → **Assign assets**:
   - **Apps:** your app, **Full control** ("Manage app").
   - **WhatsApp accounts:** your WABA, **Full control** ("Manage WhatsApp Business accounts").
3. **Generate token** → select the app → tick **`whatsapp_business_messaging`** and **`whatsapp_business_management`**. Meta's get-started guide also lists `business_management`; tick it only if generation refuses without it.
   - Token expiry: choose **Never** if offered. **Unverified:** the pages read do not describe the expiry options.
4. Copy the token **once**, straight into the CRM (§6). Never paste it into chat, email, git or a ticket. To check it: the **Access Token Debugger** (developers.facebook.com/tools/debug/accesstoken).

## 5. Webhook (incoming messages and button taps)

The CRM's endpoint is `https://<crm-host>/api/whatsapp/webhook`. It must be reachable from the internet over HTTPS with a **valid certificate**. Meta: *"Self-signed certificates are not supported."*

**Before** clicking Verify in Meta, the CRM must already have the verify token and the app secret (§6). Otherwise verification fails.

1. **App secret:** App Dashboard → **App settings → Basic** → **App secret** → Show. → `META_APP_SECRET` in the root `.env` on the VPS (§6). The CRM rejects every webhook event with 503 until it is set. (This menu path is from Meta's linked basic-settings page; the WhatsApp pages read only link to it.)
2. **Verify token:** make up a long random string, e.g. `openssl rand -hex 24`. → CRM `webhook_verify_token`.
3. App Dashboard → **WhatsApp → Configuration**. For apps created with this use case it may be **Use cases → Customize → Configuration**. **Edit**:
   - Callback URL: `https://<crm-host>/api/whatsapp/webhook`
   - Verify token: the string from step 2
   - **Verify and Save.** Meta sends `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; the CRM answers 200 with the challenge only if the token matches.
4. Under **Webhook fields → Manage**, subscribe to **`messages`**. Customer and driver messages and button taps arrive through it.
5. **Subscribe the app to your WABA.** Meta: *"all Webhook events for the phone numbers under this account will be sent to your configured Webhooks endpoint"* only after this.

   ```bash
   curl -X POST "https://graph.facebook.com/v26.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <PERMANENT_TOKEN>"
   # expect {"success": true}; GET on the same URL lists the subscribed apps
   ```

6. Switch the app to **Live** mode (App Dashboard top bar). Meta: *"some webhooks will not be sent if your app is in Dev mode."* Live mode may ask for a privacy policy URL; use the biharcabs.com privacy page.

What the CRM already does with webhooks:
- Checks Meta's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, keyed with the app secret) before reading anything. Unsigned or wrongly signed events get 401.
- Processes each message ID once. Meta retries failed deliveries *"a few more times with decreasing frequency over the next 7 days"*, so duplicates are expected and ignored.

## 6. Put the values into the CRM

**On the VPS, root `.env`** (never in git), then recreate the container (`docker compose up -d crm`):
```
META_APP_SECRET=<app secret from §5.1>
```

**In the database** (`crm_settings`, key `meta_whatsapp_config`). The Settings page has no form for this, so set it with psql, as the role that applies migrations. `\prompt` keeps the secrets out of your shell history:

```sql
\prompt 'Access token: ' token
\prompt 'Webhook verify token: ' verify
UPDATE crm_settings
SET setting_value = setting_value
    || jsonb_build_object(
         'api_version', 'v26.0',
         'phone_number_id', '<PHONE_NUMBER_ID>',
         'business_account_id', '<WABA_ID>',
         'access_token', :'token',
         'webhook_verify_token', :'verify')
WHERE setting_key = 'meta_whatsapp_config';
```

- **`api_version` must change.** The CRM was set up with `v21.0`, which Meta's version table expires on **21 January 2027**. `v26.0` (released 29 July 2026) is the newest version listed there. Some WhatsApp doc pages already show `v27.0` in examples, but it is not in Meta's version table yet; stay on `v26.0`. **Unverified:** no send has been made yet on `v26.0`. The CRM uses only `/messages` and `/media`, but do the test in §7 before relying on it.
- The CRM re-reads settings within a minute; no restart needed.
- **Admin alert recipients** are the `admin_escalation_contacts` setting. Check it lists the right phones.
- **Template names** are in `whatsapp_templates`, already filled by migration 16 with the `bc_…` names in [whatsapp_templates.md](whatsapp_templates.md). Change them only if Meta approves a template under a different name. Change `language` only if Meta uses a code other than `en` (e.g. `en_US`).

**Check:** the top bar's WhatsApp pill turns green ("configured"). The CRM does not show the token again; a set secret shows as `********`.

## 7. Test before going live

1. From a personal WhatsApp, send `hi` to the business number. The bot should answer with the welcome message.
   - No answer: check the CRM log (`docker logs biharcabs_crm`) for `invalid_signature` or `webhook_not_configured` (app secret), and in Meta, check the webhook field subscription and `subscribed_apps` (§5).
2. Within 24 hours of that message (the customer service window), make a test booking for that phone. Free-form messages go out without templates.
3. Outside the window, messages need **approved templates** (§9). Until then, they fail and are listed under **Failed messages** on the dispatch board.

## 8. Limits and charges

- **24-hour customer service window:** opens when someone messages you. Inside it the CRM sends free-form messages; outside it, only approved templates are delivered. The CRM handles this automatically.
- **Messaging limit:** *"the maximum number of unique WhatsApp user phone numbers your business can deliver messages to, outside of a customer service window, within a moving 24-hour period."*
  - It is set per **business portfolio**, shared by all its numbers. New portfolios start at **250**.
  - It rises to **2,000** after business verification, or after 2,000 delivered high-quality template messages to unique users in 30 days. After that it rises automatically (10,000 → 100,000 → unlimited) when quality is high and you use at least half your limit for a week.
  - **For BiharCabs:** every ride alert to a driver who hasn't messaged in 24 hours counts. Verify the business early.
- **Pricing:** per message since 1 July 2025, charged only when delivered.
  - Template messages are charged by category (utility is cheaper than marketing).
  - **From 1 October 2026,** utility messages inside the window are charged too, and free-form service messages are free only for the first **1,000 per number per month**. Beyond that they need a payment method, or they are not delivered.
  - Rates for India (country code 91) are on Meta's rate card (INR), linked from the pricing page.
  - **Check in Billing:** the pricing page says eligible Indian accounts must move billing to **INR by 31 December 2026**, or non-INR messages stop on 1 January 2027. **Unverified in detail:** this came from the part of the page read as a summary, so confirm it in WhatsApp Manager → Billing.
- **Phone numbers:** a new portfolio can register 2 numbers (20 after verification).

## 9. Templates

Submit the 14 templates exactly as in [whatsapp_templates.md](whatsapp_templates.md): WhatsApp Manager → **Message templates → Create template**, category **Utility**, language English.
- Names: lowercase letters, digits and underscores.
- Every `{{n}}` needs a sample value.
- Quick-reply labels: max 25 characters. The CRM matches taps on the exact label.
- `bc_customer_gst_document` has a **Document** header; upload a sample PDF when submitting.
- Review takes **up to 24 hours**. Rejected templates can be appealed (decision within 24 hours).
- Since 9 April 2025, Meta may approve a Utility template as **Marketing** (more expensive). You have 60 days to appeal via Business Support Home → Template Category Updates.
- Low-quality templates are paused automatically (3 hours, then 6 hours, then disabled), so keep wording factual.

**Risk: the two trip-OTP templates.** `bc_customer_driver_assigned` and `bc_customer_trip_otp` include the customer's trip OTP. Meta: *"Only authentication templates can be used to send a one-time passcode for identity verification. Marketing and utility templates cannot be used for this purpose."*
- The trip OTP is a ride-start code the customer reads to the driver, not identity verification. But Meta's authentication page also says *"one-time passwords or verification codes"*, so the reviewer may still reject these two or flag them.
- Authentication templates allow only Meta's fixed text (*"<code> is your verification code."*) with a copy-code or one-tap button, so they can't carry the booking details.
- **Decision for you if they are rejected:** either send the OTP in its own authentication template (needs a code change in the CRM), or appeal with the explanation that it is a ride-start code. Submit them as Utility first and see what Meta decides.

## 10. Checklist

- [ ] Number chosen; not on the WhatsApp app (or deleted from it)
- [ ] Business portfolio; business verification started
- [ ] App created (use case "Connect with customers through WhatsApp"), WABA connected
- [ ] Terms of Service accepted in WhatsApp Manager
- [ ] Number added, display name entered, verified by SMS or voice call
- [ ] System user, assets assigned, permanent token generated
- [ ] Number registered with a 6-digit PIN (stored safely)
- [ ] `META_APP_SECRET` in VPS `.env`, container recreated
- [ ] `meta_whatsapp_config` set, `api_version` = `v26.0`
- [ ] Webhook verified, `messages` field subscribed, `subscribed_apps` done, app **Live**
- [ ] `hi` from a personal phone gets the bot's reply
- [ ] Payment method on the WhatsApp account; INR billing checked
- [ ] 14 templates submitted; approvals tracked; template names match `whatsapp_templates`
- [ ] `admin_escalation_contacts` correct

## Sources (read 21 November 2026)

- Get started: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- Tokens, registration, subscribed_apps: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-solution-partners
- Webhooks: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview and https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
- Phone numbers: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers
- Display names: https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names
- Messaging limits: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- Templates: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview, https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization, https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates
- Pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- API versions: https://developers.facebook.com/docs/graph-api/changelog/versions/
