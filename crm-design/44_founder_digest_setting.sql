-- ==============================================================================
-- Migration 44: Founder WhatsApp Digest (8:00 AM & 8:00 PM IST)
-- ==============================================================================

INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'founder_whatsapp_digest',
    '{
        "enabled": true,
        "phones": [],
        "morning_hour_ist": 8,
        "evening_hour_ist": 20,
        "last_morning_sent_date": null,
        "last_evening_sent_date": null
    }'::jsonb,
    'Automated Founder WhatsApp Digest schedule (8:00 AM morning recap & 8:00 PM evening live summary in IST). Empty phones falls back to admin_escalation_contacts.'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('44', 'Founder WhatsApp Digest setting (8 AM and 8 PM IST)')
ON CONFLICT (version) DO NOTHING;
