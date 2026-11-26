import { DomainError } from './route-errors';
import { query } from './db';
import { round2 } from './fare-split';
import {
  FuelPriceApiConfig,
  FuelPriceSyncState,
  getFuelPriceApiConfig,
  getFuelPriceSyncState,
  updateSetting,
} from './settings';

/**
 * Daily-cached Fuel Price API sync service.
 * - Provider-agnostic: works with RapidAPI free tier (X-RapidAPI-Key + X-RapidAPI-Host),
 *   Zyla API Hub, or any free/custom JSON endpoint configured dynamically in crm_settings.
 * - Cached per IST calendar day (Asia/Kolkata): at most 1 external API call per day (~30/month).
 * - Never fabricates prices or overwrites existing DB prices on failure.
 */

export class FuelSyncError extends DomainError {
  constructor(message: string, status: number) {
    super(message, status);
  }
}

export interface ExtractedFuelPrices {
  PETROL?: number;
  DIESEL?: number;
  CNG?: number;
}

export interface FuelSyncResult {
  synced: boolean;
  cached: boolean;
  skipped?: string;
  dateIst: string;
  updated: ExtractedFuelPrices;
  state: FuelPriceSyncState;
}

const MIN_VALID_PRICE = 10;
const MAX_VALID_PRICE = 500;
const AUTO_SYNC_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

let inMemorySyncedDateIst: string | null = null;
let lastAutoSyncFailureAt = 0;
let inFlightSync: Promise<FuelSyncResult> | null = null;

/** Current YYYY-MM-DD calendar date in India Standard Time (Asia/Kolkata). */
export function todayIstDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value || '1970';
  const m = parts.find((p) => p.type === 'month')?.value || '01';
  const d = parts.find((p) => p.type === 'day')?.value || '01';
  return `${y}-${m}-${d}`;
}

function parseRealisticPrice(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= MIN_VALID_PRICE && raw <= MAX_VALID_PRICE ? round2(raw) : null;
  }
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[₹,\s]/g, '').replace(/\/(l|ltr|litre|kg).*$/i, '').trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= MIN_VALID_PRICE && n <= MAX_VALID_PRICE ? round2(n) : null;
  }
  return null;
}

function getByDotPath(obj: any, path: string): unknown {
  if (!obj || !path) return undefined;
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: any = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function extractNumberFromNode(node: unknown): number | null {
  const direct = parseRealisticPrice(node);
  if (direct !== null) return direct;
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    const preferredKeys = ['retailPrice', 'retail_price', 'price', 'rate', 'today', 'value', 'amount'];
    for (const k of preferredKeys) {
      if (k in obj) {
        const parsed = parseRealisticPrice(obj[k]);
        if (parsed !== null) return parsed;
      }
    }
  }
  return null;
}

function searchKeyRecursively(node: unknown, matcher: (key: string) => boolean, depth = 0): number | null {
  if (depth > 6 || !node || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchKeyRecursively(item, matcher, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;
  // First pass: check matching keys at this level
  for (const [key, val] of Object.entries(obj)) {
    if (matcher(key.toLowerCase())) {
      const parsed = extractNumberFromNode(val);
      if (parsed !== null) return parsed;
    }
  }
  // Second pass: recurse into nested objects/arrays
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = searchKeyRecursively(val, matcher, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Extract Petrol, Diesel, and CNG prices from an arbitrary JSON payload.
 * Uses explicit dot-paths if configured, otherwise auto-detects across common India fuel API schemas.
 */
export function extractFuelPricesFromPayload(
  payload: unknown,
  paths?: { petrol_path?: string; diesel_path?: string; cng_path?: string }
): ExtractedFuelPrices {
  const out: ExtractedFuelPrices = {};

  const petrol = paths?.petrol_path
    ? extractNumberFromNode(getByDotPath(payload, paths.petrol_path))
    : searchKeyRecursively(payload, (k) => k === 'petrol' || k === 'petrol_price' || k === 'petrolprice');

  const diesel = paths?.diesel_path
    ? extractNumberFromNode(getByDotPath(payload, paths.diesel_path))
    : searchKeyRecursively(payload, (k) => k === 'diesel' || k === 'diesel_price' || k === 'dieselprice');

  const cng = paths?.cng_path
    ? extractNumberFromNode(getByDotPath(payload, paths.cng_path))
    : searchKeyRecursively(payload, (k) => k === 'cng' || k === 'cng_price' || k === 'cngprice');

  if (petrol !== null) out.PETROL = petrol;
  if (diesel !== null) out.DIESEL = diesel;
  if (cng !== null) out.CNG = cng;
  return out;
}

/**
 * Extract a single fuel price from a city/state array response (e.g. IndianAPI:
 * `[{"city":"Patna","price":"105.18","change":"0.00"}, ...]`) or single object.
 */
export function extractSingleFuelPriceFromPayload(
  payload: unknown,
  opts: { city?: string; state?: string; explicitPath?: string } = {}
): number | null {
  if (opts.explicitPath) {
    return extractNumberFromNode(getByDotPath(payload, opts.explicitPath));
  }

  const targetCity = String(opts.city || '').trim().toLowerCase();
  const targetState = String(opts.state || '').trim().toLowerCase();

  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as any).data)
      ? (payload as any).data
      : null;

  if (list) {
    const match = list.find((item: any) => {
      if (!item || typeof item !== 'object') return false;
      const c = String(item.city || item.district || item.location || '').trim().toLowerCase();
      const s = String(item.state || '').trim().toLowerCase();
      return (targetCity && c === targetCity) || (targetState && s === targetState);
    });
    if (match) return extractNumberFromNode(match);
    return null;
  }

  return extractNumberFromNode(payload);
}

export function buildFuelApiUrl(cfg: FuelPriceApiConfig, fuelType?: string): string {
  const raw = String(cfg.endpoint_url || '').trim();
  if (!raw) throw new FuelSyncError('Fuel Price API endpoint URL is not configured in System Settings.', 400);
  const state = encodeURIComponent(String(cfg.state || '').trim().toLowerCase());
  const city = encodeURIComponent(String(cfg.city || '').trim().toLowerCase());
  let url = raw.replace(/\{state\}/gi, state).replace(/\{city\}/gi, city);
  if (fuelType) {
    url = url.replace(/\{fuel_type\}/gi, encodeURIComponent(fuelType.toLowerCase()));
  }
  return url;
}

async function performSync(opts: { force?: boolean; adminId?: number | null }): Promise<FuelSyncResult> {
  const dateIst = todayIstDate();
  const cfg = await getFuelPriceApiConfig();
  const existingState = await getFuelPriceSyncState();

  if (!opts.force) {
    if (!cfg.enabled || !cfg.endpoint_url) {
      return {
        synced: false,
        cached: false,
        skipped: 'Fuel Price API auto-sync is disabled or not configured.',
        dateIst,
        updated: {},
        state: existingState,
      };
    }
    if (existingState.last_synced_date_ist === dateIst) {
      inMemorySyncedDateIst = dateIst;
      return {
        synced: false,
        cached: true,
        dateIst,
        updated: existingState.updated_fuels || {},
        state: existingState,
      };
    }
  } else if (!cfg.endpoint_url) {
    throw new FuelSyncError('Fuel Price API endpoint URL is not configured. Save it in System Settings first.', 400);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.api_host) {
    headers['X-RapidAPI-Host'] = cfg.api_host;
    if (cfg.api_key) headers['X-RapidAPI-Key'] = cfg.api_key;
  } else if (cfg.api_key) {
    if (cfg.auth_header) {
      headers[cfg.auth_header] = cfg.api_key;
    } else {
      headers['Authorization'] = `Bearer ${cfg.api_key}`;
    }
  }

  let extracted: ExtractedFuelPrices = {};
  let sourceUrl = '';

  if (/\{fuel_type\}/i.test(cfg.endpoint_url)) {
    // Per-fuel endpoint mode (e.g. IndianAPI: /live_fuel_price?fuel_type={fuel_type}&location_type=city)
    sourceUrl = buildFuelApiUrl(cfg, 'petrol');
    const fuelTargets: Array<{ key: keyof ExtractedFuelPrices; slug: string; path?: string }> = [
      { key: 'PETROL', slug: 'petrol', path: cfg.petrol_path || undefined },
      { key: 'DIESEL', slug: 'diesel', path: cfg.diesel_path || undefined },
      { key: 'CNG', slug: 'cng', path: cfg.cng_path || undefined },
    ];
    let lastHttpErr: string | null = null;

    await Promise.all(
      fuelTargets.map(async ({ key, slug, path }) => {
        try {
          const url = buildFuelApiUrl(cfg, slug);
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
          if (!res.ok) {
            lastHttpErr = `Fuel Price API returned HTTP ${res.status} for ${slug}.`;
            return;
          }
          const payload = await res.json();
          const price = extractSingleFuelPriceFromPayload(payload, {
            city: cfg.city,
            state: cfg.state,
            explicitPath: path,
          });
          if (price !== null) extracted[key] = price;
        } catch (err: any) {
          lastHttpErr = err?.name === 'TimeoutError' ? 'Fuel Price API timed out.' : 'Unable to reach Fuel Price API.';
        }
      })
    );

    if (Object.keys(extracted).length === 0) {
      const msg =
        lastHttpErr ||
        `No valid Petrol, Diesel, or CNG prices were found for "${cfg.city || cfg.state}" in the API response.`;
      await updateSetting('fuel_price_sync_state', { ...existingState, last_error: msg }, 'Daily fuel price API sync state');
      throw new FuelSyncError(msg, 502);
    }
  } else {
    sourceUrl = buildFuelApiUrl(cfg);
    let res: Response;
    try {
      res = await fetch(sourceUrl, { headers, signal: AbortSignal.timeout(8000) });
    } catch (err: any) {
      const msg = err?.name === 'TimeoutError' ? 'Fuel Price API timed out.' : 'Unable to reach Fuel Price API.';
      await updateSetting('fuel_price_sync_state', { ...existingState, last_error: msg }, 'Daily fuel price API sync state');
      throw new FuelSyncError(msg, 502);
    }

    if (!res.ok) {
      const msg = `Fuel Price API returned HTTP ${res.status}.`;
      await updateSetting('fuel_price_sync_state', { ...existingState, last_error: msg }, 'Daily fuel price API sync state');
      throw new FuelSyncError(msg, 502);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      const msg = 'Fuel Price API returned non-JSON response.';
      await updateSetting('fuel_price_sync_state', { ...existingState, last_error: msg }, 'Daily fuel price API sync state');
      throw new FuelSyncError(msg, 502);
    }

    extracted = extractFuelPricesFromPayload(payload, {
      petrol_path: cfg.petrol_path,
      diesel_path: cfg.diesel_path,
      cng_path: cfg.cng_path,
    });
  }

  const entries = Object.entries(extracted) as Array<[keyof ExtractedFuelPrices, number]>;
  if (entries.length === 0) {
    const msg = 'No valid Petrol, Diesel, or CNG prices were found in the API response. Check the endpoint URL or JSON paths in System Settings.';
    await updateSetting('fuel_price_sync_state', { ...existingState, last_error: msg }, 'Daily fuel price API sync state');
    throw new FuelSyncError(msg, 422);
  }

  for (const [fuelType, price] of entries) {
    const unit = fuelType === 'CNG' ? 'KG' : 'LITRE';
    await query(
      `INSERT INTO crm_fuel_prices (fuel_type, price_per_unit, unit, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (fuel_type) DO UPDATE
       SET price_per_unit = EXCLUDED.price_per_unit,
           updated_by = COALESCE(EXCLUDED.updated_by, crm_fuel_prices.updated_by),
           updated_at = CURRENT_TIMESTAMP`,
      [fuelType, price, unit, opts.adminId ?? null]
    );
  }

  const newState: FuelPriceSyncState = {
    last_synced_date_ist: dateIst,
    synced_at: new Date().toISOString(),
    source_url: sourceUrl,
    updated_fuels: Object.fromEntries(entries),
    last_error: null,
  };
  await updateSetting('fuel_price_sync_state', newState, 'Daily fuel price API sync state');
  inMemorySyncedDateIst = dateIst;

  return {
    synced: true,
    cached: false,
    dateIst,
    updated: extracted,
    state: newState,
  };
}

/**
 * Sync fuel prices from the configured API, deduplicating concurrent requests.
 * When `force` is false (default), serves from today's IST daily cache without making an HTTP call.
 */
export async function syncFuelPricesFromApi(opts: { force?: boolean; adminId?: number | null } = {}): Promise<FuelSyncResult> {
  if (!opts.force && inMemorySyncedDateIst === todayIstDate()) {
    const state = await getFuelPriceSyncState();
    return {
      synced: false,
      cached: true,
      dateIst: inMemorySyncedDateIst,
      updated: state.updated_fuels || {},
      state,
    };
  }

  if (inFlightSync && !opts.force) return inFlightSync;

  const p = performSync(opts).finally(() => {
    if (inFlightSync === p) inFlightSync = null;
  });
  if (!opts.force) inFlightSync = p;
  return p;
}

/**
 * Safe, zero-overhead daily auto-sync hook called before pricing reads.
 * - Returns immediately in 0ms once today's IST date is cached in memory.
 * - Never throws or blocks bookings/pricing if the external fuel API fails.
 */
export async function ensureDailyFuelPricesSynced(): Promise<void> {
  const today = todayIstDate();
  if (inMemorySyncedDateIst === today) return;
  if (Date.now() - lastAutoSyncFailureAt < AUTO_SYNC_RETRY_COOLDOWN_MS) return;

  try {
    await syncFuelPricesFromApi({ force: false });
  } catch (err: any) {
    lastAutoSyncFailureAt = Date.now();
    console.warn('[FuelSync] Daily auto-sync failed, retaining existing DB fuel prices:', err?.message);
  }
}

/** Reset in-memory cache (used in tests or when settings change). */
export function resetFuelSyncMemoryCache(): void {
  inMemorySyncedDateIst = null;
  lastAutoSyncFailureAt = 0;
}
