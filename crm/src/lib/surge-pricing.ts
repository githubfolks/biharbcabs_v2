import { query } from './db';

export type PricingRuleType = 'NIGHT' | 'FESTIVAL' | 'PEAK_DATE' | 'CITY_DEMAND';
export type AdjustmentType = 'PERCENT' | 'FLAT';

export interface PricingRule {
  id: number;
  name: string;
  rule_type: PricingRuleType;
  booking_type: string | null;
  origin_city: string | null;
  cab_category: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  adjustment_type: AdjustmentType;
  adjustment_value: number;
  priority: number;
  is_active: boolean;
}

export interface SurgeEvalContext {
  bookingType?: string | null;
  originCity?: string | null;
  cabCategory?: string | null;
  pickupDate?: string | null; // YYYY-MM-DD
  pickupTime?: string | null; // HH:MM
}

export interface SurgeEvalResult {
  basePreGst: number;
  surgeAmountPreGst: number;
  adjustedPreGst: number;
  appliedRules: Array<{
    id: number;
    name: string;
    rule_type: PricingRuleType;
    adjustment_type: AdjustmentType;
    adjustment_value: number;
    amount: number;
  }>;
}

function norm(s: string | null | undefined): string {
  return String(s || '').trim().toLowerCase();
}

function toMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Pure time-window matcher supporting overnight windows (e.g. 22:00 to 05:00).
 */
export function isTimeInWindow(
  pickupTime: string | null | undefined,
  startTime: string | null | undefined,
  endTime: string | null | undefined
): boolean {
  if (!startTime && !endTime) return true;
  const t = toMinutes(pickupTime);
  if (t === null) return false;
  const start = toMinutes(startTime) ?? 0;
  const end = toMinutes(endTime) ?? 23 * 60 + 59;
  if (start <= end) {
    return t >= start && t <= end;
  }
  // Overnight window (e.g. 22:00 -> 05:00)
  return t >= start || t <= end;
}

export function doesRuleMatch(rule: PricingRule, ctx: SurgeEvalContext): boolean {
  if (!rule.is_active) return false;
  if (rule.booking_type && norm(rule.booking_type) !== norm(ctx.bookingType)) return false;
  if (rule.origin_city && norm(ctx.originCity) && !norm(ctx.originCity).includes(norm(rule.origin_city))) {
    return false;
  }
  if (rule.origin_city && !norm(ctx.originCity)) return false;
  if (rule.cab_category && norm(rule.cab_category) !== norm(ctx.cabCategory)) return false;

  if (rule.start_date || rule.end_date) {
    const d = (ctx.pickupDate || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    if (rule.start_date && d < String(rule.start_date).slice(0, 10)) return false;
    if (rule.end_date && d > String(rule.end_date).slice(0, 10)) return false;
  }

  if (rule.start_time || rule.end_time) {
    if (!isTimeInWindow(ctx.pickupTime, rule.start_time, rule.end_time)) return false;
  }

  return true;
}

/**
 * Evaluate active surge/peak/night rules against a pre-GST fare.
 * Applies all matching rules ordered by priority DESC (caps total surge at +100% for safety).
 */
export function evaluateSurgeRules(
  basePreGst: number,
  rules: PricingRule[],
  ctx: SurgeEvalContext
): SurgeEvalResult {
  const matching = rules
    .filter((r) => doesRuleMatch(r, ctx))
    .sort((a, b) => Number(b.priority) - Number(a.priority));

  let totalSurge = 0;
  const appliedRules: SurgeEvalResult['appliedRules'] = [];

  for (const r of matching) {
    const val = Number(r.adjustment_value || 0);
    if (val <= 0) continue;
    const rawAmt = r.adjustment_type === 'PERCENT' ? (basePreGst * val) / 100 : val;
    const amount = Math.round(rawAmt * 100) / 100;
    totalSurge = Math.round((totalSurge + amount) * 100) / 100;
    appliedRules.push({
      id: Number(r.id),
      name: r.name,
      rule_type: r.rule_type,
      adjustment_type: r.adjustment_type,
      adjustment_value: val,
      amount,
    });
  }

  // Safety guardrail: never exceed 2x base fare from stacked rules
  const cappedSurge = Math.min(totalSurge, Math.round(basePreGst * 100) / 100);
  return {
    basePreGst: Math.round(basePreGst * 100) / 100,
    surgeAmountPreGst: cappedSurge,
    adjustedPreGst: Math.round((basePreGst + cappedSurge) * 100) / 100,
    appliedRules,
  };
}

export async function listActivePricingRules(): Promise<PricingRule[]> {
  const res = await query(
    `SELECT * FROM crm_pricing_rules WHERE is_active = true ORDER BY priority DESC, id DESC`
  );
  return res.rows.map((r) => ({
    ...r,
    id: Number(r.id),
    adjustment_value: Number(r.adjustment_value),
    priority: Number(r.priority),
    start_date: r.start_date ? new Date(r.start_date).toISOString().slice(0, 10) : null,
    end_date: r.end_date ? new Date(r.end_date).toISOString().slice(0, 10) : null,
    start_time: r.start_time ? String(r.start_time).slice(0, 5) : null,
    end_time: r.end_time ? String(r.end_time).slice(0, 5) : null,
  }));
}
