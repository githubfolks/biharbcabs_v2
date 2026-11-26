import { DomainError } from './route-errors';
import { query } from './db';
import { getLocationIqConfig, getPackageDistanceTolerancePct, getSplitRules } from './settings';
import { FareSplit, SplitRules, round2, splitPreGstFare } from './fare-split';
import { BOOKING_TYPES, CAB_CATEGORIES, FUEL_TYPES } from './booking-rules';
import { DrivingDistanceResult, resolveDrivingDistance } from './locationiq';
import { ensureDailyFuelPricesSynced } from './fuel-price-sync';

/**
 * Dynamic CRM Pricing Engine (Single Source of Truth for CRM Operator UI, WhatsApp Bot & WordPress).
 * Implements the confirmed Biharcabs Cab Plans.xlsx formula + CA GST/Commission split rules.
 * Zero hardcoded pricing values: all inputs come from crm_fuel_prices, crm_cab_types, crm_packages, and crm_settings.
 */

export class CatalogError extends DomainError {
  constructor(message: string, status: number) {
    super(message, status);
  }
}

export interface FuelPriceRow {
  fuel_type: string;
  price_per_unit: number;
  unit: string;
  updated_by: number | null;
  updated_at: string;
}

export interface CabTypeRow {
  id: number;
  public_id: string;
  code: string;
  category: string;
  display_name: string;
  fuel_type: string;
  mileage_kmpl: number;
  per_day_charge: number;
  base_buffer_minutes: number;
  extra_hour_charge: number;
  extra_km_charge: number;
  driver_ta: number;
  seating_capacity: number;
  luggage_bags: number;
  models_description: string | null;
  image_url: string | null;
  is_active: boolean;
}

export interface PackageRow {
  id: number;
  public_id: string;
  name: string;
  booking_type: string;
  sub_type: string | null;
  cab_type_id: number;
  included_km: number;
  included_hours: number;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface PackagePriceBreakdown {
  fuelLitres: number;
  fuelCost: number;
  cabTimeCharge: number;
  driverTa: number;
  /** Pre-GST fare (Total Fair) = fuelCost + cabTimeCharge + driverTa */
  totalFairPreGst: number;
  gstPct: number;
  gstCharge: number;
  /** Total customer payable = totalFairPreGst + gstCharge */
  totalPayment: number;
  commissionPct: number;
  adminCommission: number;
  techFeeAmount: number;
  gstOnCommissionAndTechFee: number;
  totalCompanyDuesZ: number;
  driverGrossEarnings: number;
  split: FareSplit;
}

export interface PricedPackage extends PackageRow {
  cab_type: CabTypeRow;
  fuel_price_per_unit: number;
  pricing: PackagePriceBreakdown;
}

/**
 * Pure package fare calculation matching Biharcabs Cab Plans.xlsx + CA rules.
 * Throws if fuelPricePerUnit <= 0 or mileageKmpl <= 0 (never silently prices with zero fuel cost).
 */
export function calculatePackagePricing(input: {
  includedKm: number;
  includedHours: number;
  mileageKmpl: number;
  fuelPricePerUnit: number;
  perDayCharge: number;
  baseBufferMinutes: number;
  driverTa: number;
  splitRules: SplitRules;
}): PackagePriceBreakdown {
  const {
    includedKm,
    includedHours,
    mileageKmpl,
    fuelPricePerUnit,
    perDayCharge,
    baseBufferMinutes,
    driverTa,
    splitRules,
  } = input;

  if (!(includedKm > 0) || !(includedHours > 0)) {
    throw new CatalogError('Package KM and Hours must be positive numbers.', 400);
  }
  if (!(mileageKmpl > 0)) {
    throw new CatalogError('Cab mileage (CML) must be greater than zero.', 400);
  }
  if (!(fuelPricePerUnit > 0)) {
    throw new CatalogError('Fuel price (FP) must be configured and greater than zero.', 409);
  }

  const fuelLitres = includedKm / mileageKmpl;
  const fuelCost = round2(fuelLitres * fuelPricePerUnit);
  const hourlyBaseRate = perDayCharge / 12;
  const bufferHours = Math.max(0, baseBufferMinutes) / 60;
  const cabTimeCharge = round2(hourlyBaseRate * (includedHours + bufferHours));
  const ta = round2(Math.max(0, driverTa));

  const totalFairPreGst = round2(fuelCost + cabTimeCharge + ta);
  const split = splitPreGstFare(totalFairPreGst, splitRules);

  return {
    fuelLitres: round2(fuelLitres),
    fuelCost,
    cabTimeCharge,
    driverTa: ta,
    totalFairPreGst: split.rideTaxableValue,
    gstPct: splitRules.ride_fare_gst_pct,
    gstCharge: split.rideGstAmount,
    totalPayment: split.customerTotalFare,
    commissionPct: splitRules.platform_commission_pct,
    adminCommission: split.platformCommission,
    techFeeAmount: split.techFeeAmount,
    gstOnCommissionAndTechFee: split.gstAmount,
    totalCompanyDuesZ: split.totalCompanyDuesZ,
    driverGrossEarnings: split.driverGrossEarnings,
    split,
  };
}

export interface DistanceAdjustedPricing extends PackagePriceBreakdown {
  roadDistanceKm: number;
  billedKm: number;
  extraKm: number;
  extraKmChargePreGst: number;
  isRoundTrip: boolean;
  tripDays: number;
  extraDays: number;
  extraDayCabChargePreGst: number;
  extraDayDriverTaPreGst: number;
  tolerancePct: number;
  maxAllowedKm: number;
  withinPackageRange: boolean;
}

export interface RoundTripOptions {
  isRoundTrip?: boolean;
  tripDays?: number;
  perDayCharge?: number;
  driverTa?: number;
  tolerancePct?: number;
}

/**
 * Calculate inclusive trip days for a round trip (same-day return = 1 day, next-day = 2 days).
 * Throws CatalogError(400) if returnDate is earlier than pickupDate.
 */
export function calculateTripDays(
  pickupDate?: string | null,
  returnDate?: string | null,
  isRoundTrip?: boolean
): number {
  if (!isRoundTrip) return 1;
  const p = String(pickupDate || '').trim();
  const r = String(returnDate || '').trim();
  if (!p || !r) return 1;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p) || !/^\d{4}-\d{2}-\d{2}$/.test(r)) {
    throw new CatalogError('Pickup date and return date must be in YYYY-MM-DD format.', 400);
  }
  const pMs = Date.parse(`${p}T00:00:00Z`);
  const rMs = Date.parse(`${r}T00:00:00Z`);
  if (!Number.isFinite(pMs) || !Number.isFinite(rMs)) {
    throw new CatalogError('Invalid pickup or return date.', 400);
  }
  if (rMs < pMs) {
    throw new CatalogError('Return date cannot be earlier than pickup date.', 400);
  }
  const diffDays = Math.round((rMs - pMs) / (24 * 60 * 60 * 1000));
  if (diffDays > 60) {
    throw new CatalogError('Round trip duration cannot exceed 60 days.', 400);
  }
  return diffDays + 1;
}

/**
 * Recalculate package fare for road distance and optional Round Trip:
 * - For Round Trip: doubles one-way road distance (2x km) and for multi-day trips (tripDays > 1),
 *   adds (tripDays - 1) * (cab.per_day_charge + cab.driver_ta) to pre-GST Total Fair.
 * - Adds extraKm * cab.extra_km_charge when effective road distance exceeds includedKm.
 * - Recalculates Ride GST, Platform Charge, Final Payment, Admin Commission, and Driver Earnings
 *   via the single splitPreGstFare() formula.
 */
export function calculateDistanceAdjustedPricing(
  basePricing: PackagePriceBreakdown,
  includedKm: number,
  extraKmRate: number,
  roadDistanceKm: number | null | undefined,
  splitRules: SplitRules,
  roundTrip?: RoundTripOptions
): DistanceAdjustedPricing {
  const isRoundTrip = Boolean(roundTrip?.isRoundTrip);
  const tripDays = isRoundTrip ? Math.max(1, Math.round(Number(roundTrip?.tripDays || 1))) : 1;
  const extraDays = isRoundTrip ? Math.max(0, tripDays - 1) : 0;
  const tolerancePct =
    roundTrip?.tolerancePct !== undefined && Number.isFinite(Number(roundTrip.tolerancePct))
      ? Math.max(0, Number(roundTrip.tolerancePct))
      : 20;
  const maxAllowedKm = round2(includedKm * (1 + tolerancePct / 100));

  const rawRoadKm = Number(roadDistanceKm);
  const hasRoadKm = Number.isFinite(rawRoadKm) && rawRoadKm > 0;
  const effectiveRoadKm = hasRoadKm ? round2(isRoundTrip ? rawRoadKm * 2 : rawRoadKm) : includedKm;
  const withinPackageRange = !hasRoadKm || effectiveRoadKm <= maxAllowedKm;

  const extraKm = hasRoadKm && effectiveRoadKm > includedKm ? round2(effectiveRoadKm - includedKm) : 0;
  const extraKmChargePreGst = round2(extraKm * Math.max(0, extraKmRate));
  const extraDayCabChargePreGst = round2(extraDays * Math.max(0, Number(roundTrip?.perDayCharge || 0)));
  const extraDayDriverTaPreGst = round2(extraDays * Math.max(0, Number(roundTrip?.driverTa || 0)));

  const totalExtraPreGst = round2(extraKmChargePreGst + extraDayCabChargePreGst + extraDayDriverTaPreGst);
  if (totalExtraPreGst <= 0) {
    return {
      ...basePricing,
      roadDistanceKm: effectiveRoadKm,
      billedKm: includedKm,
      extraKm: 0,
      extraKmChargePreGst: 0,
      isRoundTrip,
      tripDays,
      extraDays,
      extraDayCabChargePreGst: 0,
      extraDayDriverTaPreGst: 0,
      tolerancePct,
      maxAllowedKm,
      withinPackageRange,
    };
  }

  const adjustedPreGst = round2(basePricing.totalFairPreGst + totalExtraPreGst);
  const split = splitPreGstFare(adjustedPreGst, splitRules);

  return {
    ...basePricing,
    totalFairPreGst: split.rideTaxableValue,
    gstPct: splitRules.ride_fare_gst_pct,
    gstCharge: split.rideGstAmount,
    totalPayment: split.customerTotalFare,
    commissionPct: splitRules.platform_commission_pct,
    adminCommission: split.platformCommission,
    techFeeAmount: split.techFeeAmount,
    gstOnCommissionAndTechFee: split.gstAmount,
    totalCompanyDuesZ: split.totalCompanyDuesZ,
    driverGrossEarnings: split.driverGrossEarnings,
    split,
    roadDistanceKm: effectiveRoadKm,
    billedKm: Math.max(includedKm, effectiveRoadKm),
    extraKm,
    extraKmChargePreGst,
    isRoundTrip,
    tripDays,
    extraDays,
    extraDayCabChargePreGst,
    extraDayDriverTaPreGst,
    tolerancePct,
    maxAllowedKm,
    withinPackageRange,
  };
}

/** Throw HTTP 422 CatalogError when route distance exceeds package included KM + tolerance%. */
export function assertWithinPackageDistanceRange(
  packageName: string,
  includedKm: number,
  pricing: DistanceAdjustedPricing
): void {
  if (!pricing.withinPackageRange) {
    throw new CatalogError(
      `Route distance (${pricing.roadDistanceKm} km${pricing.isRoundTrip ? ' round-trip' : ''}) exceeds the maximum allowed range of ${pricing.maxAllowedKm} km (${includedKm} km + ${pricing.tolerancePct}% tolerance) for package "${packageName}". Please select a higher-KM package.`,
      422
    );
  }
}

export interface RouteDistanceInput {
  fromCoords?: { lat: number; lon: number } | null;
  toCoords?: { lat: number; lon: number } | null;
  originText?: string | null;
  destinationText?: string | null;
  isRoundTrip?: boolean;
  pickupDate?: string | null;
  returnDate?: string | null;
}

/** Parse an optional coordinate pair from query params or JSON body (returns null if incomplete or invalid). */
export function parseOptionalCoords(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  if (lat === undefined || lat === null || String(lat).trim() === '') return null;
  if (lon === undefined || lon === null || String(lon).trim() === '') return null;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return { lat: la, lon: lo };
}

/**
 * Single canonical road-distance resolver for all fare calculations across CRM, Public API, and WhatsApp Bot.
 * Uses LocationIQ with PostgreSQL caching; returns null if LocationIQ is unconfigured or unreachable
 * (never fabricates a distance).
 */
export async function resolveRouteDistanceSafely(
  input: RouteDistanceInput,
  contextLabel = 'Pricing'
): Promise<DrivingDistanceResult | null> {
  const hasCoords = Boolean(input.fromCoords && input.toCoords);
  const origin = String(input.originText || '').trim();
  const destination = String(input.destinationText || '').trim();
  if (!hasCoords && (!origin || !destination)) return null;

  try {
    const locCfg = await getLocationIqConfig();
    if (!locCfg.api_key) return null;
    return await resolveDrivingDistance({
      fromCoords: input.fromCoords ?? null,
      toCoords: input.toCoords ?? null,
      originText: origin || null,
      destinationText: destination || null,
    });
  } catch (err: any) {
    console.warn(`[${contextLabel}] Road distance resolution skipped, using base package KM:`, err?.message);
    return null;
  }
}

/**
 * Price a single package for a given route using the canonical road-distance calculation.
 */
export async function pricePackageForRoute(
  pkg: PricedPackage,
  route: RouteDistanceInput,
  contextLabel = 'Pricing'
): Promise<{
  routeDistance: DrivingDistanceResult | null;
  pricing: DistanceAdjustedPricing;
}> {
  const isRoundTrip = Boolean(route.isRoundTrip);
  const tripDays = calculateTripDays(route.pickupDate, route.returnDate, isRoundTrip);
  const [routeDistance, splitRules, tolerancePct] = await Promise.all([
    resolveRouteDistanceSafely(route, contextLabel),
    getSplitRules(),
    getPackageDistanceTolerancePct(),
  ]);
  const pricing = calculateDistanceAdjustedPricing(
    pkg.pricing,
    pkg.included_km,
    pkg.cab_type.extra_km_charge,
    routeDistance?.distance_km ?? null,
    splitRules,
    {
      isRoundTrip,
      tripDays,
      perDayCharge: pkg.cab_type.per_day_charge,
      driverTa: pkg.cab_type.driver_ta,
      tolerancePct,
    }
  );
  return { routeDistance, pricing };
}

/**
 * When a route's actual driving distance is known, keep only the best-fitting (smallest included_km,
 * then smallest included_hours) package per (booking_type, cab_code) that covers the route.
 * Prevents showing oversized 12hr / 250km / 300km plans for a short 55 km trip.
 */
export function selectBestFittingPlansPerCab<T>(
  items: T[],
  getKey: (item: T) => string,
  getIncludedKm: (item: T) => number,
  getIncludedHours: (item: T) => number
): T[] {
  const bestByKey = new Map<string, T>();
  const keyOrder: string[] = [];

  for (const item of items) {
    const key = getKey(item);
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, item);
      keyOrder.push(key);
      continue;
    }
    const km = getIncludedKm(item);
    const exKm = getIncludedKm(existing);
    if (km < exKm || (km === exKm && getIncludedHours(item) < getIncludedHours(existing))) {
      bestByKey.set(key, item);
    }
  }

  return keyOrder.map((k) => bestByKey.get(k)!);
}

function mapCab(r: any): CabTypeRow {
  return {
    id: Number(r.id),
    public_id: String(r.public_id),
    code: String(r.code),
    category: String(r.category),
    display_name: String(r.display_name),
    fuel_type: String(r.fuel_type),
    mileage_kmpl: Number(r.mileage_kmpl),
    per_day_charge: Number(r.per_day_charge),
    base_buffer_minutes: Number(r.base_buffer_minutes),
    extra_hour_charge: Number(r.extra_hour_charge),
    extra_km_charge: Number(r.extra_km_charge),
    driver_ta: Number(r.driver_ta),
    seating_capacity: Number(r.seating_capacity),
    luggage_bags: Number(r.luggage_bags),
    models_description: r.models_description ?? null,
    image_url: r.image_url ? String(r.image_url) : null,
    is_active: Boolean(r.is_active),
  };
}

export async function listFuelPrices(): Promise<FuelPriceRow[]> {
  await ensureDailyFuelPricesSynced();
  const res = await query(`SELECT * FROM crm_fuel_prices ORDER BY fuel_type ASC`);
  return res.rows.map((r) => ({
    fuel_type: String(r.fuel_type),
    price_per_unit: Number(r.price_per_unit),
    unit: String(r.unit),
    updated_by: r.updated_by ? Number(r.updated_by) : null,
    updated_at: r.updated_at,
  }));
}

export async function updateFuelPrice(
  fuelType: string,
  pricePerUnit: number,
  adminId: number,
  unit?: string
): Promise<FuelPriceRow> {
  const ft = String(fuelType || '').trim().toUpperCase();
  if (!FUEL_TYPES.includes(ft as any)) {
    throw new CatalogError(`Fuel type must be one of: ${FUEL_TYPES.join(', ')}`, 400);
  }
  if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
    throw new CatalogError('Fuel price must be a non-negative number.', 400);
  }
  const res = await query(
    `INSERT INTO crm_fuel_prices (fuel_type, price_per_unit, unit, updated_by, updated_at)
     VALUES ($1, $2, COALESCE($3, 'LITRE'), $4, CURRENT_TIMESTAMP)
     ON CONFLICT (fuel_type) DO UPDATE
     SET price_per_unit = EXCLUDED.price_per_unit,
         unit = COALESCE($3, crm_fuel_prices.unit),
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [ft, round2(pricePerUnit), unit || null, adminId]
  );
  const r = res.rows[0];
  return {
    fuel_type: String(r.fuel_type),
    price_per_unit: Number(r.price_per_unit),
    unit: String(r.unit),
    updated_by: r.updated_by ? Number(r.updated_by) : null,
    updated_at: r.updated_at,
  };
}

export async function listCabTypes(opts?: { activeOnly?: boolean }): Promise<CabTypeRow[]> {
  const sql = opts?.activeOnly
    ? `SELECT * FROM crm_cab_types WHERE is_active = true ORDER BY per_day_charge ASC, id ASC`
    : `SELECT * FROM crm_cab_types ORDER BY per_day_charge ASC, id ASC`;
  const res = await query(sql);
  return res.rows.map(mapCab);
}

export async function createCabType(input: {
  category: string;
  fuel_type: string;
  display_name?: string;
  mileage_kmpl: number;
  per_day_charge: number;
  base_buffer_minutes?: number;
  extra_hour_charge: number;
  extra_km_charge: number;
  driver_ta?: number;
  seating_capacity?: number;
  luggage_bags?: number;
  models_description?: string | null;
  image_url?: string | null;
  is_active?: boolean;
}): Promise<CabTypeRow> {
  const category = String(input.category || '').trim().toUpperCase();
  const fuelType = String(input.fuel_type || '').trim().toUpperCase();
  if (!CAB_CATEGORIES.includes(category as any)) {
    throw new CatalogError(`category must be one of: ${CAB_CATEGORIES.join(', ')}`, 400);
  }
  if (!FUEL_TYPES.includes(fuelType as any)) {
    throw new CatalogError(`fuel_type must be one of: ${FUEL_TYPES.join(', ')}`, 400);
  }
  const mileage = Number(input.mileage_kmpl);
  const pdcrg = Number(input.per_day_charge);
  const phexchg = Number(input.extra_hour_charge);
  const extraKm = Number(input.extra_km_charge);
  const bufferMins = input.base_buffer_minutes !== undefined ? Number(input.base_buffer_minutes) : 30;
  const driverTa = input.driver_ta !== undefined ? Number(input.driver_ta) : 0;
  const seats = input.seating_capacity !== undefined ? Number(input.seating_capacity) : 4;
  const bags = input.luggage_bags !== undefined ? Number(input.luggage_bags) : 2;

  if (!(mileage > 0) || !(pdcrg >= 0) || !(phexchg >= 0) || !(extraKm >= 0) || !(driverTa >= 0)) {
    throw new CatalogError('Mileage must be > 0 and all charges must be >= 0.', 400);
  }
  const code = `${category}_${fuelType}`;
  const displayName = String(input.display_name || `${category.replace(/_/g, ' ')} (${fuelType})`).trim();

  try {
    const res = await query(
      `INSERT INTO crm_cab_types (
         code, category, display_name, fuel_type, mileage_kmpl, per_day_charge,
         base_buffer_minutes, extra_hour_charge, extra_km_charge, driver_ta,
         seating_capacity, luggage_bags, models_description, image_url, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        code, category, displayName, fuelType, round2(mileage), round2(pdcrg),
        Math.round(bufferMins), round2(phexchg), round2(extraKm), round2(driverTa),
        Math.round(seats), Math.round(bags), input.models_description || null,
        input.image_url ? String(input.image_url).trim() : null, input.is_active ?? true,
      ]
    );
    return mapCab(res.rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new CatalogError(`Cab type ${category} with fuel ${fuelType} already exists.`, 409);
    }
    throw err;
  }
}

export async function updateCabType(id: number, input: Partial<CabTypeRow>): Promise<CabTypeRow> {
  const existingRes = await query(`SELECT * FROM crm_cab_types WHERE id = $1`, [id]);
  const e = existingRes.rows[0];
  if (!e) throw new CatalogError('Cab type not found.', 404);

  const displayName = input.display_name !== undefined ? String(input.display_name).trim() : e.display_name;
  const mileage = input.mileage_kmpl !== undefined ? Number(input.mileage_kmpl) : Number(e.mileage_kmpl);
  const pdcrg = input.per_day_charge !== undefined ? Number(input.per_day_charge) : Number(e.per_day_charge);
  const bufferMins = input.base_buffer_minutes !== undefined ? Number(input.base_buffer_minutes) : Number(e.base_buffer_minutes);
  const phexchg = input.extra_hour_charge !== undefined ? Number(input.extra_hour_charge) : Number(e.extra_hour_charge);
  const extraKm = input.extra_km_charge !== undefined ? Number(input.extra_km_charge) : Number(e.extra_km_charge);
  const driverTa = input.driver_ta !== undefined ? Number(input.driver_ta) : Number(e.driver_ta);
  const seats = input.seating_capacity !== undefined ? Number(input.seating_capacity) : Number(e.seating_capacity);
  const bags = input.luggage_bags !== undefined ? Number(input.luggage_bags) : Number(e.luggage_bags);
  const models = input.models_description !== undefined ? input.models_description : e.models_description;
  const imageUrl =
    input.image_url !== undefined
      ? (input.image_url ? String(input.image_url).trim() : null)
      : (e.image_url ?? null);
  const isActive = input.is_active !== undefined ? Boolean(input.is_active) : Boolean(e.is_active);

  if (!(mileage > 0) || !(pdcrg >= 0) || !(phexchg >= 0) || !(extraKm >= 0) || !(driverTa >= 0)) {
    throw new CatalogError('Mileage must be > 0 and all charges must be >= 0.', 400);
  }

  const res = await query(
    `UPDATE crm_cab_types
     SET display_name = $1, mileage_kmpl = $2, per_day_charge = $3, base_buffer_minutes = $4,
         extra_hour_charge = $5, extra_km_charge = $6, driver_ta = $7, seating_capacity = $8,
         luggage_bags = $9, models_description = $10, image_url = $11, is_active = $12, updated_at = CURRENT_TIMESTAMP
     WHERE id = $13
     RETURNING *`,
    [displayName, round2(mileage), round2(pdcrg), Math.round(bufferMins), round2(phexchg), round2(extraKm), round2(driverTa), Math.round(seats), Math.round(bags), models, imageUrl, isActive, id]
  );
  return mapCab(res.rows[0]);
}

export async function createPackage(input: {
  name: string;
  booking_type: string;
  sub_type?: string | null;
  cab_type_id: number;
  included_km: number;
  included_hours: number;
  description?: string | null;
  is_active?: boolean;
  sort_order?: number;
}): Promise<PackageRow> {
  const name = String(input.name || '').trim();
  const bookingType = String(input.booking_type || '').trim().toUpperCase();
  const cabTypeId = Number(input.cab_type_id);
  const km = Number(input.included_km);
  const hours = Number(input.included_hours);

  if (!name) throw new CatalogError('Package name is required.', 400);
  if (!BOOKING_TYPES.includes(bookingType as any)) {
    throw new CatalogError(`booking_type must be one of: ${BOOKING_TYPES.join(', ')}`, 400);
  }
  if (!Number.isInteger(cabTypeId) || cabTypeId <= 0) throw new CatalogError('Valid cab_type_id is required.', 400);
  if (!(km > 0) || !(hours > 0)) throw new CatalogError('included_km and included_hours must be greater than zero.', 400);

  const cabCheck = await query(`SELECT id, is_active FROM crm_cab_types WHERE id = $1`, [cabTypeId]);
  if (cabCheck.rows.length === 0) throw new CatalogError('Selected cab type does not exist.', 404);
  if (!cabCheck.rows[0].is_active) throw new CatalogError('Selected cab type is inactive. Activate it before creating a package.', 400);

  const res = await query(
    `INSERT INTO crm_packages (name, booking_type, sub_type, cab_type_id, included_km, included_hours, description, is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [name, bookingType, input.sub_type || null, cabTypeId, round2(km), round2(hours), input.description || null, input.is_active ?? true, Number(input.sort_order || 0)]
  );
  const r = res.rows[0];
  return {
    ...r,
    id: Number(r.id),
    cab_type_id: Number(r.cab_type_id),
    included_km: Number(r.included_km),
    included_hours: Number(r.included_hours),
    sort_order: Number(r.sort_order),
  };
}

export async function updatePackage(id: number, input: Partial<PackageRow>): Promise<PackageRow> {
  const existingRes = await query(`SELECT * FROM crm_packages WHERE id = $1`, [id]);
  const e = existingRes.rows[0];
  if (!e) throw new CatalogError('Package not found.', 404);

  const name = input.name !== undefined ? String(input.name).trim() : e.name;
  const bookingType = input.booking_type !== undefined ? String(input.booking_type).trim().toUpperCase() : e.booking_type;
  const subType = input.sub_type !== undefined ? input.sub_type : e.sub_type;
  const cabTypeId = input.cab_type_id !== undefined ? Number(input.cab_type_id) : Number(e.cab_type_id);
  const km = input.included_km !== undefined ? Number(input.included_km) : Number(e.included_km);
  const hours = input.included_hours !== undefined ? Number(input.included_hours) : Number(e.included_hours);
  const description = input.description !== undefined ? input.description : e.description;
  const isActive = input.is_active !== undefined ? Boolean(input.is_active) : Boolean(e.is_active);
  const sortOrder = input.sort_order !== undefined ? Number(input.sort_order) : Number(e.sort_order);

  if (!name || !BOOKING_TYPES.includes(bookingType as any) || !(km > 0) || !(hours > 0)) {
    throw new CatalogError('Invalid package fields.', 400);
  }
  if (cabTypeId !== Number(e.cab_type_id)) {
    const cabCheck = await query(`SELECT id, is_active FROM crm_cab_types WHERE id = $1`, [cabTypeId]);
    if (cabCheck.rows.length === 0) throw new CatalogError('Selected cab type does not exist.', 404);
    if (!cabCheck.rows[0].is_active) throw new CatalogError('Selected cab type is inactive. Activate it first.', 400);
  }

  const res = await query(
    `UPDATE crm_packages
     SET name = $1, booking_type = $2, sub_type = $3, cab_type_id = $4, included_km = $5,
         included_hours = $6, description = $7, is_active = $8, sort_order = $9, updated_at = CURRENT_TIMESTAMP
     WHERE id = $10
     RETURNING *`,
    [name, bookingType, subType, cabTypeId, round2(km), round2(hours), description, isActive, sortOrder, id]
  );
  const r = res.rows[0];
  return {
    ...r,
    id: Number(r.id),
    cab_type_id: Number(r.cab_type_id),
    included_km: Number(r.included_km),
    included_hours: Number(r.included_hours),
    sort_order: Number(r.sort_order),
  };
}

async function hydratePricedPackages(rows: any[], skipUnpriceable: boolean): Promise<PricedPackage[]> {
  const splitRules = await getSplitRules();
  const result: PricedPackage[] = [];

  for (const r of rows) {
    const fuelPrice = Number(r.fuel_price_per_unit);
    if (!(fuelPrice > 0)) {
      if (skipUnpriceable) continue;
      throw new CatalogError(`Fuel price for ${r.cab_fuel_type} is not configured (> 0).`, 409);
    }
    const cab: CabTypeRow = {
      id: Number(r.cab_id),
      public_id: String(r.cab_public_id),
      code: String(r.cab_code),
      category: String(r.cab_category),
      display_name: String(r.cab_display_name),
      fuel_type: String(r.cab_fuel_type),
      mileage_kmpl: Number(r.mileage_kmpl),
      per_day_charge: Number(r.per_day_charge),
      base_buffer_minutes: Number(r.base_buffer_minutes),
      extra_hour_charge: Number(r.extra_hour_charge),
      extra_km_charge: Number(r.extra_km_charge),
      driver_ta: Number(r.driver_ta),
      seating_capacity: Number(r.seating_capacity),
      luggage_bags: Number(r.luggage_bags),
      models_description: r.models_description ?? null,
      image_url: r.cab_image_url ? String(r.cab_image_url) : null,
      is_active: Boolean(r.cab_is_active),
    };
    const pricing = calculatePackagePricing({
      includedKm: Number(r.included_km),
      includedHours: Number(r.included_hours),
      mileageKmpl: cab.mileage_kmpl,
      fuelPricePerUnit: fuelPrice,
      perDayCharge: cab.per_day_charge,
      baseBufferMinutes: cab.base_buffer_minutes,
      driverTa: cab.driver_ta,
      splitRules,
    });
    result.push({
      id: Number(r.id),
      public_id: String(r.public_id),
      name: String(r.name),
      booking_type: String(r.booking_type),
      sub_type: r.sub_type ?? null,
      cab_type_id: Number(r.cab_type_id),
      included_km: Number(r.included_km),
      included_hours: Number(r.included_hours),
      description: r.description ?? null,
      is_active: Boolean(r.is_active),
      sort_order: Number(r.sort_order),
      cab_type: cab,
      fuel_price_per_unit: fuelPrice,
      pricing,
    });
  }
  return result;
}

const PACKAGE_SELECT = `
  SELECT
    p.id, p.public_id, p.name, p.booking_type, p.sub_type, p.cab_type_id,
    p.included_km, p.included_hours, p.description, p.is_active, p.sort_order,
    c.id AS cab_id, c.public_id AS cab_public_id, c.code AS cab_code, c.category AS cab_category,
    c.display_name AS cab_display_name, c.fuel_type AS cab_fuel_type, c.mileage_kmpl,
    c.per_day_charge, c.base_buffer_minutes, c.extra_hour_charge, c.extra_km_charge,
    c.driver_ta, c.seating_capacity, c.luggage_bags, c.models_description, c.image_url AS cab_image_url, c.is_active AS cab_is_active,
    f.price_per_unit AS fuel_price_per_unit
  FROM crm_packages p
  JOIN crm_cab_types c ON c.id = p.cab_type_id
  JOIN crm_fuel_prices f ON f.fuel_type = c.fuel_type
`;

export async function listPricedPackages(opts?: {
  activeOnly?: boolean;
  bookingType?: string | null;
  skipUnpriceable?: boolean;
}): Promise<PricedPackage[]> {
  await ensureDailyFuelPricesSynced();
  const where: string[] = [];
  const params: any[] = [];

  if (opts?.activeOnly) {
    where.push(`p.is_active = true AND c.is_active = true`);
  }
  if (opts?.bookingType) {
    params.push(String(opts.bookingType).trim().toUpperCase());
    where.push(`p.booking_type = $${params.length}`);
  }

  const sql = `${PACKAGE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.booking_type ASC, p.sort_order ASC, c.per_day_charge ASC, p.id ASC`;
  const res = await query(sql, params);
  return hydratePricedPackages(res.rows, Boolean(opts?.skipUnpriceable));
}

export async function getPricedPackageById(id: number): Promise<PricedPackage | null> {
  await ensureDailyFuelPricesSynced();
  const res = await query(`${PACKAGE_SELECT} WHERE p.id = $1`, [id]);
  if (res.rows.length === 0) return null;
  const list = await hydratePricedPackages(res.rows, false);
  return list[0] ?? null;
}

export async function getPricedPackageByPublicId(publicId: string): Promise<PricedPackage | null> {
  await ensureDailyFuelPricesSynced();
  const res = await query(`${PACKAGE_SELECT} WHERE p.public_id = $1 AND p.is_active = true AND c.is_active = true`, [publicId]);
  if (res.rows.length === 0) return null;
  const list = await hydratePricedPackages(res.rows, false);
  return list[0] ?? null;
}
