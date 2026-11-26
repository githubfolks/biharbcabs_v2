import { query } from './db';
import { getDriverRatingPolicy, getDriverRideGapHours } from './settings';
import { pickupMoment } from './pickup-time';

/**
 * Live city-wise Cab Category availability engine (zero hardcoded counts).
 * Counts real active, verified, compliant drivers & vehicles in the source city,
 * subtracting drivers whose schedule clashes with an existing assigned/in-progress ride
 * within `driver_ride_gap_hours` of the requested pickup time.
 */

export interface CategoryAvailability {
  city: string;
  category: string;
  total_cabs: number;
  available_cabs: number;
  is_available: boolean;
}

export function normalizeCabCategory(codeOrCategory: string): string {
  return String(codeOrCategory || '')
    .trim()
    .toUpperCase()
    .replace(/_(PETROL|DIESEL|CNG)$/, '');
}

/**
 * Fetch real-time total and available cab counts per Cab Category in a given source city.
 * Single SQL query (no N+1). Uses dynamic settings (min_dispatch_rating, driver_ride_gap_hours).
 */
export async function getCityCabAvailability(input: {
  originCity: string;
  pickupDate?: string | null;
  pickupTime?: string | null;
}): Promise<Record<string, CategoryAvailability>> {
  const city = String(input.originCity || '').trim();
  if (!city) return {};

  const ratingPolicy = await getDriverRatingPolicy();
  const gapHours = await getDriverRideGapHours();
  const pickupAt =
    input.pickupDate && input.pickupTime
      ? pickupMoment(input.pickupDate, input.pickupTime)
      : null;

  const res = await query(
    `WITH eligible_fleet AS (
       SELECT DISTINCT
         d.id AS driver_id,
         COALESCE(
           ct.category,
           UPPER(REGEXP_REPLACE(v.wp_vehicle_code, '_(PETROL|DIESEL|CNG)$', '', 'i'))
         ) AS cab_category,
         CASE
           WHEN EXISTS (
             SELECT 1 FROM crm_bookings sb
             WHERE (sb.assigned_driver_id = d.id OR sb.assigned_vehicle_id = v.id)
               AND sb.booking_status = 'TRIP_IN_PROGRESS'
           ) THEN true
           WHEN $3::timestamptz IS NOT NULL THEN EXISTS (
             SELECT 1 FROM crm_bookings sb
             WHERE (sb.assigned_driver_id = d.id OR sb.assigned_vehicle_id = v.id)
               AND sb.booking_status = 'DRIVER_ASSIGNED'
               AND ABS(EXTRACT(EPOCH FROM (((sb.pickup_date + sb.pickup_time) AT TIME ZONE 'Asia/Kolkata') - $3::timestamptz)))
                   < ($4::numeric) * 3600
           )
           ELSE false
         END AS is_busy
       FROM crm_drivers d
       JOIN crm_driver_vehicles v ON v.driver_id = d.id AND v.removed_at IS NULL
       LEFT JOIN crm_cab_types ct ON ct.id = v.cab_type_id
       WHERE (
           LOWER(TRIM(d.base_city)) = LOWER(TRIM($1))
           OR (
             LENGTH(TRIM(d.base_city)) >= 3
             AND LOWER($1) ~ ('(^|[^a-z0-9])' || REGEXP_REPLACE(LOWER(TRIM(d.base_city)), '[^a-z0-9 ]', '', 'g') || '($|[^a-z0-9])')
           )
         )
         AND d.onboarding_status = 'APPROVED_ACTIVE'
         AND d.is_available = true
         AND NOT d.offers_paused
         AND d.rating >= ($2::numeric)
         AND (d.license_expiry IS NULL OR d.license_expiry >= CURRENT_DATE)
         AND v.is_verified = true
         AND (v.insurance_expiry IS NULL OR v.insurance_expiry >= CURRENT_DATE)
         AND (v.fitness_expiry IS NULL OR v.fitness_expiry >= CURRENT_DATE)
         AND (v.permit_expiry IS NULL OR v.permit_expiry >= CURRENT_DATE)
     )
     SELECT
       cab_category,
       COUNT(*)::int AS total_cabs,
       COUNT(*) FILTER (WHERE NOT is_busy)::int AS available_cabs
     FROM eligible_fleet
     GROUP BY cab_category`,
    [city, ratingPolicy.min_dispatch_rating, pickupAt, gapHours]
  );

  const map: Record<string, CategoryAvailability> = {};
  for (const r of res.rows) {
    const cat = String(r.cab_category || '').toUpperCase();
    const total = Number(r.total_cabs || 0);
    const available = Number(r.available_cabs || 0);
    map[cat] = {
      city,
      category: cat,
      total_cabs: total,
      available_cabs: available,
      is_available: available > 0,
    };
  }
  return map;
}

/** Convenience lookup for a single category in a city (always returns a full object, defaulting to 0 when none). */
export async function checkCategoryAvailability(input: {
  originCity: string;
  category: string;
  pickupDate?: string | null;
  pickupTime?: string | null;
}): Promise<CategoryAvailability> {
  const cat = normalizeCabCategory(input.category);
  const all = await getCityCabAvailability(input);
  return (
    all[cat] ?? {
      city: String(input.originCity || '').trim(),
      category: cat,
      total_cabs: 0,
      available_cabs: 0,
      is_available: false,
    }
  );
}
