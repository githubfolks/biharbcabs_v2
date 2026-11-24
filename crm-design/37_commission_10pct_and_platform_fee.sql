-- Migration 37: Update default Admin Commission to 10% and disable extra GST on driver commission.
-- Platform Charge (tech_fee_amount = 10) is added to Customer Final Payment; Driver earns Total Fair - Admin Commission.

UPDATE crm_settings
SET setting_value = COALESCE(setting_value, '{}'::jsonb) || jsonb_build_object(
      'platform_commission_pct', 10,
      'gst_on_commission_pct', 0,
      'tech_fee_amount', COALESCE((setting_value->>'tech_fee_amount')::numeric, 10)
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'revenue_protection_policy';

INSERT INTO crm_schema_migrations (version, description)
VALUES ('37', 'Set platform_commission_pct to 10% and gst_on_commission_pct to 0% for customer-billed platform charge model')
ON CONFLICT (version) DO NOTHING;
