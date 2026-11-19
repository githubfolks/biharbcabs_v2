-- ==============================================================================
-- Migration 25: Minimum gap between a driver's rides
-- ==============================================================================
-- Nothing stopped a driver holding two rides at the same time: a driver with a 10:00 pickup could be
-- offered, accept, or be assigned by staff another 10:00 ride, even mid-trip. Bookings store only a
-- pickup time, not an end time, so the rule (owner decision) is a fixed gap: a driver cannot be offered,
-- accept or be assigned a ride whose pickup is within driver_ride_gap_hours (4) before or after the
-- pickup of a ride they already hold (DRIVER_ASSIGNED or TRIP_IN_PROGRESS). Staff cannot override it;
-- they reassign the other ride first. Safe to run more than once.

INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'driver_ride_gap_hours',
    '{ "value": 4 }'::jsonb,
    'Minimum hours between the pickups of two rides held by the same driver'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('25', 'Minimum gap between a driver''s rides')
ON CONFLICT (version) DO NOTHING;
