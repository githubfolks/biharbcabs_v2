import { SplitRules } from './fare-split';
import { query } from './db';
import { checkReturnTripPolicy, ReturnTripPolicyCheck } from './return-trip-pricing';

interface CacheEntry {
  data: Record<string, any>;
  expiresAt: number;
}

let settingsCache: CacheEntry | null = null;
const CACHE_TTL_MS = 60 * 1000; // 1 minute in-memory cache

export interface MetaWhatsAppConfig {
  api_version: string;
  phone_number_id: string;
  business_account_id: string;
  access_token: string;
  webhook_verify_token: string;
}

export interface AdminEscalationContact {
  name: string;
  phone: string;
  role: string;
}

export interface CompanyBillingInfo {
  legal_name: string;
  trade_name: string;
  phone: string;
  email: string;
  address: string;
  gstin: string;
  tax_percentage: number;
  hsn_sac: string;
}

export interface WhatsAppIntentsConfig {
  greetings: {
    keywords: string[];
    welcome_message: string;
    buttons: Array<{ id: string; title: string }>;
  };
  driver_onboarding: {
    keywords: string[];
    prompt_name: string;
    prompt_city: string;
    prompt_vehicle: string;
    prompt_reg: string;
  };
  customer_prompts: {
    ask_origin: string;
    ask_destination: string;
    ask_landmark: string;
    custom_quote_notice: string;
  };
  fallback_message: string;
}

/**
 * Load all settings from crm_settings table dynamically.
 */
export async function getAllSettings(forceFresh = false): Promise<Record<string, any>> {
  const now = Date.now();
  if (!forceFresh && settingsCache && settingsCache.expiresAt > now) {
    return settingsCache.data;
  }

  const res = await query('SELECT setting_key, setting_value FROM crm_settings');
  const settingsMap: Record<string, any> = {};

  for (const row of res.rows) {
    settingsMap[row.setting_key] = row.setting_value;
  }

  settingsCache = {
    data: settingsMap,
    expiresAt: now + CACHE_TTL_MS,
  };

  return settingsMap;
}

/**
 * Get a single setting dynamically.
 */
export async function getSetting<T = any>(key: string, defaultValue?: T): Promise<T> {
  const all = await getAllSettings();
  if (key in all) {
    return all[key] as T;
  }
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw new Error(`[Settings] Configuration key '${key}' not found in crm_settings`);
}

/**
 * Update a dynamic setting in the database and flush in-memory cache.
 */
export async function updateSetting(
  key: string,
  value: any,
  description?: string
): Promise<void> {
  await query(
    `INSERT INTO crm_settings (setting_key, setting_value, description, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (setting_key) DO UPDATE
     SET setting_value = EXCLUDED.setting_value,
         description = COALESCE(EXCLUDED.description, crm_settings.description),
         updated_at = CURRENT_TIMESTAMP`,
    [key, JSON.stringify(value), description || null]
  );

  // Invalidate cache immediately
  settingsCache = null;
}

/**
 * Invalidate the cache manually.
 */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

// Convenient Type-Safe Accessors
export async function getDispatchSlaTimeoutMinutes(): Promise<number> {
  const setting = await getSetting<{ value: number }>('dispatch_sla_timeout_minutes', { value: 15 });
  return setting.value;
}

export async function getDriverWakeupCheckHours(): Promise<number> {
  const setting = await getSetting<{ value: number }>('driver_wakeup_check_hours_before', { value: 2 });
  return setting.value;
}

/**
 * Minutes before pickup at which admins are alerted about an assigned driver who has not confirmed the
 * wake-up check (60, owner decision). An invalid setting falls back to 60 and is logged: a missed safety
 * alert is the worse failure.
 */
export async function getWakeupUnconfirmedAlertMinutes(): Promise<number> {
  const raw = Number((await getSetting<{ value: number }>('driver_wakeup_unconfirmed_alert_minutes', { value: 60 })).value);
  if (!Number.isInteger(raw) || raw < 5 || raw > 600) {
    console.error('[Settings] driver_wakeup_unconfirmed_alert_minutes is invalid; using 60.');
    return 60;
  }
  return raw;
}

/** Minimum hours between the pickups of two rides one driver holds (migration 25). */
export async function getDriverRideGapHours(): Promise<number> {
  const raw = Number((await getSetting<{ value: number }>('driver_ride_gap_hours', { value: 4 })).value);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 24) {
    // A wrong setting must not let a driver be double-booked.
    console.error('[Settings] driver_ride_gap_hours is invalid; using 4.');
    return 4;
  }
  return raw;
}

export async function getMetaWhatsAppConfig(): Promise<MetaWhatsAppConfig> {
  return getSetting<MetaWhatsAppConfig>('meta_whatsapp_config');
}

export async function getWhatsAppTemplates(): Promise<Record<string, string>> {
  return getSetting<Record<string, string>>('whatsapp_templates', {
    driver_alert: 'bc_driver_ride_alert',
    customer_confirmation: 'bc_customer_driver_confirmed',
    admin_sla_alert: 'bc_admin_unconfirmed_alert',
    driver_wakeup: 'bc_driver_wakeup_check',
    customer_invoice: 'bc_customer_trip_invoice',
  });
}

export async function getAdminContacts(): Promise<AdminEscalationContact[]> {
  return getSetting<AdminEscalationContact[]>('admin_escalation_contacts', []);
}

export interface DriverRatingPolicyConfig {
  default_initial_rating: number;
  min_dispatch_rating: number;
  critical_alert_threshold: number;
  auto_suspend_consecutive_1_stars: number;
  google_review_url: string;
  min_rating_for_google_prompt: number;
  rating_timeout_hours: number;
}

export async function getCompanyBillingInfo(): Promise<CompanyBillingInfo> {
  return getSetting<CompanyBillingInfo>('company_billing_info');
}

export async function getWhatsAppIntents(): Promise<WhatsAppIntentsConfig> {
  return getSetting<WhatsAppIntentsConfig>('whatsapp_intents');
}

export async function getDriverRatingPolicy(): Promise<DriverRatingPolicyConfig> {
  return getSetting<DriverRatingPolicyConfig>('driver_rating_policy', {
    default_initial_rating: 5.0,
    min_dispatch_rating: 4.10,
    critical_alert_threshold: 3.80,
    auto_suspend_consecutive_1_stars: 2,
    google_review_url: 'https://g.page/r/biharcabs/review',
    min_rating_for_google_prompt: 4,
    rating_timeout_hours: 48,
  });
}

export interface RevenueProtectionPolicyConfig {
  platform_commission_pct: number;
  gst_on_commission_pct: number;
  tech_fee_amount: number;
  customer_convenience_fee?: number;
  night_surcharge?: number;
  roof_luggage_carrier_fee?: number;
  dynamic_credit_limits: {
    probation_or_new: number;
    standard: number;
    elite: number;
  };
  elite_min_rating: number;
  elite_min_trips: number;
  standard_min_rating: number;
  standard_min_trips?: number;
  company_upi_vpa: string;
  company_upi_name: string;
  enable_digital_only_soft_mode: boolean;
  min_dues_for_micro_recharge: number;
  target_security_reserve: number;
  reserve_deduction_per_trip: number;
  streak_bonus_target_trips: number;
  streak_bonus_amount: number;
  /** Trips below this fare do not count toward the streak bonus; null or invalid: no bonus is paid. */
  streak_min_fare: number | null;
  /** Minutes a Razorpay payment link (driver dues / driver plans) stays open. */
  payment_link_window_minutes: number;
}

export async function getRevenueProtectionPolicy(): Promise<RevenueProtectionPolicyConfig> {
  const raw = await getSetting<any>('revenue_protection_policy', {});

  const dynamicLimits = raw.dynamic_credit_limits || {
    probation_or_new: Number(raw.probation_limit ?? 300.0),
    standard: Number(raw.standard_limit ?? 1000.0),
    elite: Number(raw.elite_limit ?? 2500.0),
  };

  const windowMins = Number(raw.payment_link_window_minutes);

  return {
    platform_commission_pct: Number(raw.platform_commission_pct ?? raw.platform_facilitation_percentage ?? 12.0),
    gst_on_commission_pct: Number(raw.gst_on_commission_pct ?? raw.statutory_gst_percentage ?? 18.0),
    tech_fee_amount: Number(raw.tech_fee_amount ?? raw.flat_tech_fee ?? 10.0),
    customer_convenience_fee: Number(raw.customer_convenience_fee ?? 39.0),
    night_surcharge: Number(raw.night_surcharge ?? 200.0),
    roof_luggage_carrier_fee: Number(raw.roof_luggage_carrier_fee ?? 150.0),
    dynamic_credit_limits: {
      probation_or_new: Number(dynamicLimits.probation_or_new ?? 300.0),
      standard: Number(dynamicLimits.standard ?? 1000.0),
      elite: Number(dynamicLimits.elite ?? 2500.0),
    },
    elite_min_rating: Number(raw.elite_min_rating ?? 4.80),
    elite_min_trips: Number(raw.elite_min_trips ?? 25),
    standard_min_rating: Number(raw.standard_min_rating ?? 4.20),
    standard_min_trips: Number(raw.standard_min_trips ?? 5),
    company_upi_vpa: String(raw.company_upi_vpa || 'biharcabs@icici'),
    company_upi_name: String(raw.company_upi_name || 'BiharCabs Private Limited'),
    enable_digital_only_soft_mode: Boolean(raw.enable_digital_only_soft_mode ?? false),
    min_dues_for_micro_recharge: Number(raw.min_dues_for_micro_recharge ?? 50.0),
    target_security_reserve: Number(raw.target_security_reserve ?? 500.0),
    reserve_deduction_per_trip: Number(raw.reserve_deduction_per_trip ?? 100.0),
    streak_bonus_target_trips: Number(raw.streak_bonus_target_trips ?? 5),
    streak_bonus_amount: Number(raw.streak_bonus_amount ?? 150.0),
    streak_min_fare: Number.isFinite(Number(raw.streak_min_fare)) && Number(raw.streak_min_fare) > 0 ? Number(raw.streak_min_fare) : null,
    payment_link_window_minutes: Number.isInteger(windowMins) && windowMins >= 15 ? windowMins : 30,
  };
}

/**
 * Rules for splitting a fare (see fare-split.ts). The ride GST rate is company_billing_info.tax_percentage.
 * GST rates must be valid: a missing or broken rate stops pricing instead of silently charging 0%.
 */
export async function getSplitRules(): Promise<SplitRules> {
  const policy = await getRevenueProtectionPolicy();
  const billing = await getSetting<any>('company_billing_info', {});
  const rules: SplitRules = {
    platform_commission_pct: policy.platform_commission_pct,
    gst_on_commission_pct: policy.gst_on_commission_pct,
    ride_fare_gst_pct: Number(billing.tax_percentage),
    tech_fee_amount: policy.tech_fee_amount,
  };
  // A missing value must not count as 0% (Number(null) is 0), so the raw ride rate is checked too.
  const rawRide = billing.tax_percentage;
  const present = rawRide !== null && rawRide !== undefined && String(rawRide).trim() !== '';
  const pct = (n: number) => Number.isFinite(n) && n >= 0 && n <= 28;
  if (!present || !pct(rules.ride_fare_gst_pct) || !pct(rules.gst_on_commission_pct)) {
    throw new Error('[Settings] GST rates are missing or invalid (company_billing_info.tax_percentage, gst_on_commission_pct).');
  }
  return rules;
}

export interface DriverPlansPolicy {
  /** When true, outstation rides are offered only to drivers with an active subscription plan. */
  plan_only_rides_enabled: boolean;
  /** GST % applied on driver subscription plan purchases (confirmed by CA: 18%). */
  plan_gst_pct: number;
}

export async function getDriverPlansPolicy(): Promise<DriverPlansPolicy> {
  const raw = await getSetting<any>('driver_plans_policy', {});
  const gst = Number(raw.plan_gst_pct ?? 18.0);
  return {
    plan_only_rides_enabled: Boolean(raw.plan_only_rides_enabled ?? false),
    plan_gst_pct: Number.isFinite(gst) && gst >= 0 && gst <= 28 ? gst : 18.0,
  };
}

/** Return-trip priority and discount settings, validated: incomplete or invalid settings leave the feature off. */
export async function getReturnTripPolicy(): Promise<ReturnTripPolicyCheck> {
  const raw = await getSetting<any>('return_trip_policy', {});
  return checkReturnTripPolicy(raw);
}
