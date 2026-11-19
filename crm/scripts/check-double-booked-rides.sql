-- Read-only check, run after deploying migration 25: pairs of rides held by the same driver
-- (DRIVER_ASSIGNED or TRIP_IN_PROGRESS) whose pickups are less than driver_ride_gap_hours apart (4 if
-- the setting is missing or invalid, as in the app). The gap rule stops new clashes only; reassign one
-- ride of each pair from the dispatch board. Changes nothing: runs in a read-only transaction.
--
--   psql -d biharcabs_crm -f crm/scripts/check-double-booked-rides.sql
BEGIN READ ONLY;
WITH gap AS (
  SELECT COALESCE(
    (SELECT CASE WHEN (setting_value->>'value') ~ '^[0-9]+(\.[0-9]+)?$'
                  AND (setting_value->>'value')::numeric > 0 AND (setting_value->>'value')::numeric <= 24
                 THEN (setting_value->>'value')::numeric END
     FROM crm_settings WHERE setting_key = 'driver_ride_gap_hours'), 4) AS hours
),
held AS (
  SELECT b.id, b.booking_code, b.assigned_driver_id, b.booking_status,
         (b.pickup_date + b.pickup_time) AT TIME ZONE 'Asia/Kolkata' AS pickup_at
  FROM crm_bookings b
  WHERE b.booking_status IN ('DRIVER_ASSIGNED', 'TRIP_IN_PROGRESS') AND b.assigned_driver_id IS NOT NULL
)
SELECT d.full_name AS driver, d.phone,
       a.booking_code AS ride_1, a.booking_status AS status_1, to_char(a.pickup_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') AS pickup_1,
       b.booking_code AS ride_2, b.booking_status AS status_2, to_char(b.pickup_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') AS pickup_2,
       round(EXTRACT(EPOCH FROM (b.pickup_at - a.pickup_at)) / 3600.0, 1) AS hours_apart
FROM held a
JOIN held b ON b.assigned_driver_id = a.assigned_driver_id AND (b.pickup_at, b.id) > (a.pickup_at, a.id)
JOIN crm_drivers d ON d.id = a.assigned_driver_id
CROSS JOIN gap
WHERE EXTRACT(EPOCH FROM (b.pickup_at - a.pickup_at)) < gap.hours * 3600
ORDER BY a.pickup_at, d.full_name;
SELECT (SELECT count(*) FROM crm_bookings WHERE booking_status IN ('DRIVER_ASSIGNED', 'TRIP_IN_PROGRESS')) AS rides_held_now,
       (SELECT count(*) FROM crm_bookings) AS all_bookings,
       (SELECT setting_value FROM crm_settings WHERE setting_key = 'driver_ride_gap_hours') AS gap_setting;
ROLLBACK;
