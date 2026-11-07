-- ==============================================================================
-- Migration 07: Rolling Security Reserve Float & Ride Streak Incentive Offsets
-- ==============================================================================

-- 1. Add security reserve tracking to crm_drivers
ALTER TABLE crm_drivers
    ADD COLUMN IF NOT EXISTS security_reserve_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

-- 2. Update revenue_protection_policy with rolling reserve & streak incentive configs
UPDATE crm_settings
SET setting_value = setting_value || '{
    "target_security_reserve": 500.0,
    "reserve_deduction_per_trip": 100.0,
    "streak_bonus_target_trips": 5,
    "streak_bonus_amount": 150.0
}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'revenue_protection_policy';

