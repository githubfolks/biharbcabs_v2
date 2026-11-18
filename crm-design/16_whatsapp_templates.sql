-- ==============================================================================
-- Migration 16: WhatsApp template messages for business-initiated notifications
-- ==============================================================================
-- Meta delivers free-form (text/interactive) messages only within 24 hours of the recipient's last
-- message; outside that window only approved templates are delivered. Notifications now send the
-- template outside the window. When a recipient taps a template's quick-reply button, the webhook
-- carries the template message's id (context.id); this table maps it back to the booking or driver.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_wa_template_sends (
    wamid VARCHAR(255) PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    template_key VARCHAR(64) NOT NULL,
    ref_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_wa_template_sends_created ON crm_wa_template_sends (created_at);

-- Approved template names per notification (see crm-design/whatsapp_templates.md). Existing names are kept.
UPDATE crm_settings
SET setting_value = '{
        "language": "en",
        "driver_ride_alert": "bc_driver_ride_alert",
        "driver_trip_assigned": "bc_driver_trip_assigned",
        "driver_wakeup": "bc_driver_wakeup_check",
        "driver_dues_reminder": "bc_driver_dues_reminder",
        "driver_account_notice": "bc_driver_account_notice",
        "driver_payout_sent": "bc_driver_payout_sent",
        "customer_driver_assigned": "bc_customer_driver_assigned",
        "customer_trip_otp": "bc_customer_trip_otp",
        "customer_trip_started": "bc_customer_trip_started",
        "customer_trip_completed": "bc_customer_trip_completed",
        "customer_payment_link": "bc_customer_payment_link",
        "customer_booking_update": "bc_customer_booking_update",
        "admin_alert": "bc_admin_alert"
    }'::jsonb || setting_value,
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'whatsapp_templates';

INSERT INTO crm_settings (setting_key, setting_value, description)
SELECT 'whatsapp_templates', '{
        "language": "en",
        "driver_ride_alert": "bc_driver_ride_alert",
        "driver_trip_assigned": "bc_driver_trip_assigned",
        "driver_wakeup": "bc_driver_wakeup_check",
        "driver_dues_reminder": "bc_driver_dues_reminder",
        "driver_account_notice": "bc_driver_account_notice",
        "driver_payout_sent": "bc_driver_payout_sent",
        "customer_driver_assigned": "bc_customer_driver_assigned",
        "customer_trip_otp": "bc_customer_trip_otp",
        "customer_trip_started": "bc_customer_trip_started",
        "customer_trip_completed": "bc_customer_trip_completed",
        "customer_payment_link": "bc_customer_payment_link",
        "customer_booking_update": "bc_customer_booking_update",
        "admin_alert": "bc_admin_alert"
    }'::jsonb, 'Approved WhatsApp template names used outside the 24-hour window'
WHERE NOT EXISTS (SELECT 1 FROM crm_settings WHERE setting_key = 'whatsapp_templates');

INSERT INTO crm_schema_migrations (version, description)
VALUES ('16', 'WhatsApp templates for business-initiated notifications')
ON CONFLICT (version) DO NOTHING;
