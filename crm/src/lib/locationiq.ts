import crypto from 'crypto';
import { query } from './db';
import { getLocationIqConfig } from './settings';

/**
 * Server-side LocationIQ client for place autocomplete, geocoding, and driving distance
 * with PostgreSQL caching (crm_route_distance_cache).
 * API key is stored dynamically in crm_settings ('locationiq_config') or LOCATIONIQ_API_KEY env.
 */

export class LocationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface PlaceSuggestion {
  display_name: string;
  short_name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
}

export interface DrivingDistanceResult {
  distance_km: number;
  duration_minutes: number;
  duration_text: string;
  cached?: boolean;
}

const DEFAULT_CACHE_DAYS = 7;

function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return hours > 0 ? `${hours} hr ${rem} min` : `${minutes} min`;
}

function coordCacheKey(from: { lat: number; lon: number }, to: { lat: number; lon: number }): string {
  const raw = `coords:${from.lat.toFixed(3)},${from.lon.toFixed(3)}->${to.lat.toFixed(3)},${to.lon.toFixed(3)}`;
  return 'c_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

function textCacheKey(origin: string, destination: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const raw = `text:${norm(origin)}->${norm(destination)}`;
  return 't_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

async function readCache(cacheKey: string): Promise<DrivingDistanceResult | null> {
  try {
    const res = await query(
      `SELECT distance_km, duration_minutes, duration_text
       FROM crm_route_distance_cache
       WHERE cache_key = $1 AND expires_at > CURRENT_TIMESTAMP`,
      [cacheKey]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      distance_km: Number(r.distance_km),
      duration_minutes: Number(r.duration_minutes),
      duration_text: String(r.duration_text),
      cached: true,
    };
  } catch {
    // If cache table is not yet migrated, degrade gracefully to live lookup
    return null;
  }
}

async function writeCache(
  cacheKey: string,
  result: DrivingDistanceResult,
  meta: { originLabel?: string; destinationLabel?: string; from?: { lat: number; lon: number }; to?: { lat: number; lon: number } }
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + DEFAULT_CACHE_DAYS * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO crm_route_distance_cache (
         cache_key, origin_label, destination_label, from_lat, from_lon, to_lat, to_lon,
         distance_km, duration_minutes, duration_text, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (cache_key) DO UPDATE
       SET distance_km = EXCLUDED.distance_km,
           duration_minutes = EXCLUDED.duration_minutes,
           duration_text = EXCLUDED.duration_text,
           expires_at = EXCLUDED.expires_at,
           created_at = CURRENT_TIMESTAMP`,
      [
        cacheKey,
        meta.originLabel || null,
        meta.destinationLabel || null,
        meta.from?.lat ?? null,
        meta.from?.lon ?? null,
        meta.to?.lat ?? null,
        meta.to?.lon ?? null,
        result.distance_km,
        result.duration_minutes,
        result.duration_text,
        expiresAt,
      ]
    );
  } catch (err: any) {
    console.warn('[LocationIQ] Cache write skipped:', err?.message);
  }
}

export async function autocompletePlaces(q: string): Promise<PlaceSuggestion[]> {
  const trimmed = String(q || '').trim();
  if (trimmed.length < 3) return [];

  const cfg = await getLocationIqConfig();
  if (!cfg.api_key) {
    throw new LocationError('LocationIQ API key is not configured. Add it in System Settings.', 503);
  }

  const url =
    `https://api.locationiq.com/v1/autocomplete?` +
    new URLSearchParams({
      key: cfg.api_key,
      q: trimmed,
      countrycodes: cfg.country_codes,
      limit: '6',
    }).toString();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  } catch (err: any) {
    throw new LocationError(
      err?.name === 'TimeoutError' ? 'Location autocomplete timed out.' : 'Unable to reach LocationIQ service.',
      502
    );
  }

  if (!res.ok) {
    if (res.status === 404) return [];
    throw new LocationError(`LocationIQ autocomplete failed (HTTP ${res.status}).`, 502);
  }

  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data
    .map((item: any) => {
      const addr = item.address || {};
      const city = String(addr.city || addr.town || addr.village || addr.county || addr.state_district || item.display_place || '').trim();
      const shortName = String(addr.name || item.display_place || city || item.display_name || '').trim();
      return {
        display_name: String(item.display_name || shortName),
        short_name: shortName,
        city: city || shortName,
        state: String(addr.state || ''),
        lat: Number(item.lat),
        lon: Number(item.lon),
      };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.display_name.length > 0);
}

/** Geocode a place or city name to coordinates via LocationIQ search. */
export async function geocodePlace(placeText: string): Promise<{ lat: number; lon: number; display_name: string } | null> {
  const trimmed = String(placeText || '').trim();
  if (trimmed.length < 2) return null;

  const cfg = await getLocationIqConfig();
  if (!cfg.api_key) {
    throw new LocationError('LocationIQ API key is not configured. Add it in System Settings.', 503);
  }

  const url =
    `https://us1.locationiq.com/v1/search?` +
    new URLSearchParams({
      key: cfg.api_key,
      q: trimmed,
      countrycodes: cfg.country_codes,
      format: 'json',
      limit: '1',
    }).toString();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  } catch (err: any) {
    throw new LocationError(
      err?.name === 'TimeoutError' ? 'Location geocoding timed out.' : 'Unable to reach LocationIQ geocoding service.',
      502
    );
  }

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new LocationError(`LocationIQ geocoding failed (HTTP ${res.status}).`, 502);
  }

  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  if (!first || !Number.isFinite(Number(first.lat)) || !Number.isFinite(Number(first.lon))) return null;

  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    display_name: String(first.display_name || trimmed),
  };
}

export async function calculateDrivingDistance(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  labels?: { origin?: string; destination?: string }
): Promise<DrivingDistanceResult> {
  if (
    !Number.isFinite(from.lat) || !Number.isFinite(from.lon) ||
    !Number.isFinite(to.lat) || !Number.isFinite(to.lon)
  ) {
    throw new LocationError('Valid source and destination coordinates are required.', 400);
  }

  const key = coordCacheKey(from, to);
  const hit = await readCache(key);
  if (hit) return hit;

  const cfg = await getLocationIqConfig();
  if (!cfg.api_key) {
    throw new LocationError('LocationIQ API key is not configured. Add it in System Settings.', 503);
  }

  const coords = `${from.lon.toFixed(5)},${from.lat.toFixed(5)};${to.lon.toFixed(5)},${to.lat.toFixed(5)}`;
  const url = `https://us1.locationiq.com/v1/directions/driving/${coords}?` + new URLSearchParams({
    key: cfg.api_key,
    overview: 'false',
  }).toString();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err: any) {
    throw new LocationError(
      err?.name === 'TimeoutError' ? 'Distance calculation timed out.' : 'Unable to reach LocationIQ directions API.',
      502
    );
  }

  if (!res.ok) {
    throw new LocationError(`LocationIQ directions failed (HTTP ${res.status}).`, 502);
  }

  const data = await res.json();
  const route = data?.routes?.[0];
  if (!route || !Number.isFinite(Number(route.distance)) || Number(route.distance) <= 0) {
    throw new LocationError('Could not calculate driving distance between these locations.', 422);
  }

  const distanceKm = Math.round((Number(route.distance) / 1000) * 10) / 10;
  const durationSec = Number(route.duration || 0);
  const result: DrivingDistanceResult = {
    distance_km: distanceKm,
    duration_minutes: Math.max(1, Math.round(durationSec / 60)),
    duration_text: formatDuration(durationSec),
    cached: false,
  };

  await writeCache(key, result, { originLabel: labels?.origin, destinationLabel: labels?.destination, from, to });
  return result;
}

/**
 * Resolve driving distance from coordinates if provided, or by geocoding origin/destination text.
 * Results are cached in PostgreSQL under both coordinate and text keys.
 */
export async function resolveDrivingDistance(input: {
  fromCoords?: { lat: number; lon: number } | null;
  toCoords?: { lat: number; lon: number } | null;
  originText?: string | null;
  destinationText?: string | null;
}): Promise<DrivingDistanceResult> {
  if (input.fromCoords && input.toCoords) {
    return calculateDrivingDistance(input.fromCoords, input.toCoords, {
      origin: input.originText || undefined,
      destination: input.destinationText || undefined,
    });
  }

  const origin = String(input.originText || '').trim();
  const destination = String(input.destinationText || '').trim();
  if (!origin || !destination) {
    throw new LocationError('Provide source & destination coordinates or city/address names.', 400);
  }

  const tKey = textCacheKey(origin, destination);
  const textHit = await readCache(tKey);
  if (textHit) return textHit;

  const [fromGeo, toGeo] = await Promise.all([geocodePlace(origin), geocodePlace(destination)]);
  if (!fromGeo || !toGeo) {
    throw new LocationError(
      `Could not locate ${!fromGeo ? `"${origin}"` : `"${destination}"`} via LocationIQ.`,
      422
    );
  }

  const result = await calculateDrivingDistance(
    { lat: fromGeo.lat, lon: fromGeo.lon },
    { lat: toGeo.lat, lon: toGeo.lon },
    { origin, destination }
  );
  await writeCache(tKey, result, {
    originLabel: origin,
    destinationLabel: destination,
    from: { lat: fromGeo.lat, lon: fromGeo.lon },
    to: { lat: toGeo.lat, lon: toGeo.lon },
  });
  return result;
}
