-- ==============================================================================
-- Migration 04: Driver Ratings, Quality Assurance & Reputation Management
-- ==============================================================================

-- 1. Create crm_driver_ratings table
CREATE TABLE IF NOT EXISTS crm_driver_ratings (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL UNIQUE REFERENCES crm_bookings(id) ON DELETE CASCADE,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE CASCADE,
    customer_id BIGINT NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    feedback_category VARCHAR(50), -- 'CLEANLINESS', 'AC', 'RASH_DRIVING', 'BEHAVIOR', 'FARE_DISPUTE', 'PUNCTUALITY', 'OTHER'
    customer_comment TEXT,
    is_disputed BOOLEAN NOT NULL DEFAULT false,
    dispute_resolution_notes TEXT,
    resolved_by_admin_id BIGINT REFERENCES crm_admin_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_driver_ratings_driver ON crm_driver_ratings(driver_id);
CREATE INDEX IF NOT EXISTS idx_crm_driver_ratings_score ON crm_driver_ratings(rating);
CREATE INDEX IF NOT EXISTS idx_crm_driver_ratings_booking ON crm_driver_ratings(booking_id);

-- 2. Add performance tracking counters to crm_drivers
ALTER TABLE crm_drivers
    ADD COLUMN IF NOT EXISTS total_trips_completed INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_ratings_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rating_5_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rating_1_count INT NOT NULL DEFAULT 0;

-- 3. Dynamic Rating Policy Configuration (Stored in crm_settings for zero hardcoded values)
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'driver_rating_policy',
    '{
        "default_initial_rating": 5.0,
        "min_dispatch_rating": 4.10,
        "critical_alert_threshold": 3.80,
        "auto_suspend_consecutive_1_stars": 2,
        "google_review_url": "https://g.page/r/biharcabs/review",
        "min_rating_for_google_prompt": 4,
        "rating_timeout_hours": 48
    }'::jsonb,
    'Quality thresholds, Google Review redirect policy, and dispatch rating eligibility'
)
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    description = EXCLUDED.description,
    updated_at = CURRENT_TIMESTAMP;

