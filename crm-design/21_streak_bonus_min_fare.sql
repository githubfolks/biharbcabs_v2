-- ==============================================================================
-- Migration 21: Streak bonus only for trips at or above a minimum fare
-- ==============================================================================
-- The ride streak bonus (streak_bonus_amount every streak_bonus_target_trips trips) counted every
-- completed trip, so small trips could be booked just to farm it: five ₹500 trips earn BiharCabs about
-- ₹125, less than the ₹150 bonus. Now only trips with a fare of at least streak_min_fare count, on their
-- own counter (total_trips_completed still counts every trip, for credit tiers). ₹700 (owner decision)
-- is just above break-even: five qualifying trips earn BiharCabs at least the bonus.
-- Counters start at 0 for every driver. Safe to run more than once.

ALTER TABLE crm_drivers
    ADD COLUMN IF NOT EXISTS streak_qualifying_trips INTEGER NOT NULL DEFAULT 0;

UPDATE crm_settings
SET setting_value = '{"streak_min_fare": 700}'::jsonb || setting_value,
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'revenue_protection_policy'
  AND NOT (setting_value ? 'streak_min_fare');

INSERT INTO crm_schema_migrations (version, description)
VALUES ('21', 'Streak bonus minimum fare')
ON CONFLICT (version) DO NOTHING;
