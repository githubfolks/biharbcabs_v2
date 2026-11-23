import { getLocationIqConfig } from './settings';

/**
 * Server-side LocationIQ client for place autocomplete and driving distance.
 * Mirrors the LocationIQ integration already used in WordPress (biharcabs-growth-engine/includes/class-rest.php
 * and themes/biharcabs/assets/js/biharcabs.js). API key is kept strictly server-side and never hardcoded.
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
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return hours > 0 ? `${hours} hr ${rem} min` : `${minutes} min`;
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

export async function calculateDrivingDistance(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): Promise<DrivingDistanceResult> {
  if (
    !Number.isFinite(from.lat) || !Number.isFinite(from.lon) ||
    !Number.isFinite(to.lat) || !Number.isFinite(to.lon)
  ) {
    throw new LocationError('Valid source and destination coordinates are required.', 400);
  }

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
  return {
    distance_km: distanceKm,
    duration_minutes: Math.max(1, Math.round(durationSec / 60)),
    duration_text: formatDuration(durationSec),
  };
}
