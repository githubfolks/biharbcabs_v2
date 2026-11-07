-- ==============================================================================
-- Migration 06: Cross-Ride Debt Absorption & Automated UPI Micro-Recharges
-- ==============================================================================

-- 1. Add dues notification tracking to crm_drivers
ALTER TABLE crm_drivers
    ADD COLUMN IF NOT EXISTS last_dues_reminder_sent_at TIMESTAMPTZ;

-- 2. Update revenue_protection_policy with UPI VPA and soft-mode parameters
UPDATE crm_settings
SET setting_value = setting_value || '{
    "company_upi_vpa": "biharcabs@icici",
    "company_upi_name": "BiharCabs Private Limited",
    "enable_digital_only_soft_mode": true,
    "min_dues_for_micro_recharge": 50.0
}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'revenue_protection_policy';

