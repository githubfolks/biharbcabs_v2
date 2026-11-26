import { query } from './db';
import { getSetting } from './settings';

export type FinancialReportType = 'pnl' | 'gstr1' | 'dues_aging' | 'settlements' | 'reconciliation';

export const VALID_REPORT_TYPES: readonly FinancialReportType[] = [
  'pnl',
  'gstr1',
  'dues_aging',
  'settlements',
  'reconciliation',
];

export interface DateRange {
  from: string; // YYYY-MM-DD (IST)
  to: string;   // YYYY-MM-DD (IST)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Default date range: 1st of current IST month through today (IST). */
export function resolveDateRange(fromRaw?: string | null, toRaw?: string | null): DateRange {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const y = istNow.getUTCFullYear();
  const m = String(istNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(istNow.getUTCDate()).padStart(2, '0');
  const defaultFrom = `${y}-${m}-01`;
  const defaultTo = `${y}-${m}-${d}`;

  const from = fromRaw && DATE_RE.test(fromRaw.trim()) ? fromRaw.trim() : defaultFrom;
  const to = toRaw && DATE_RE.test(toRaw.trim()) ? toRaw.trim() : defaultTo;
  return from <= to ? { from, to } : { from: to, to: from };
}

function round2(n: unknown): number {
  const v = Number(n || 0);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/**
 * Classify overdue days into Accounts Receivable aging buckets.
 */
export function classifyAgingBucket(daysOverdue: number): '0-7d' | '8-15d' | '16-30d' | '30+d' {
  if (daysOverdue <= 7) return '0-7d';
  if (daysOverdue <= 15) return '8-15d';
  if (daysOverdue <= 30) return '16-30d';
  return '30+d';
}

/**
 * Pure P&L net platform revenue formula:
 * Net Platform Revenue = Commission + Tech Fee + Forfeited Cancellation Charges - Incentives Paid.
 * (GST is a statutory liability, not platform revenue.)
 */
export function computeNetPlatformRevenue(parts: {
  commissionRevenue: number;
  techFeeRevenue: number;
  forfeitedCharges: number;
  incentivesPaid: number;
}): number {
  return round2(
    parts.commissionRevenue + parts.techFeeRevenue + parts.forfeitedCharges - parts.incentivesPaid
  );
}

/**
 * RFC 4180 CSV serializer with spreadsheet formula-injection protection on string cells.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const escapeCell = (val: string | number | boolean | null | undefined): string => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    let str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ==============================================================================
// 1. Revenue & Margin P&L Report
// ==============================================================================
export async function getRevenuePnlReport(range: DateRange) {
  const fromTs = `${range.from}T00:00:00+05:30`;
  const toTs = `${range.to}T23:59:59.999+05:30`;

  const [dailyRes, incentivesRes, cancellationsRes] = await Promise.all([
    query(
      `SELECT
         TO_CHAR((b.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS rides_count,
         COALESCE(SUM(b.customer_total_fare), 0) AS gmv,
         COALESCE(SUM(b.customer_total_fare - b.ride_gst_amount), 0) AS pre_gst_fare,
         COALESCE(SUM(b.ride_gst_amount), 0) AS ride_gst,
         COALESCE(SUM(b.commission_amount), 0) AS commission_revenue,
         COALESCE(SUM(b.tech_fee_amount), 0) AS tech_fee_revenue,
         COALESCE(SUM(b.gst_amount), 0) AS commission_gst,
         COALESCE(SUM(b.driver_payout_amount), 0) AS driver_payout,
         COALESCE(SUM(b.cash_collected_by_driver), 0) AS cash_collected,
         COALESCE(SUM(b.advance_paid), 0) AS advance_online
       FROM crm_bookings b
       WHERE b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')
         AND b.created_at BETWEEN $1::timestamptz AND $2::timestamptz
       GROUP BY 1
       ORDER BY 1 DESC`,
      [fromTs, toTs]
    ),
    query(
      `SELECT COALESCE(SUM(amount), 0) AS total_incentives
       FROM crm_payments_ledger
       WHERE transaction_type IN ('INCENTIVE_BONUS', 'INCENTIVE_STREAK_BONUS')
         AND created_at BETWEEN $1::timestamptz AND $2::timestamptz`,
      [fromTs, toTs]
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE booking_status = 'CANCELLED')::int AS cancellations_count,
         COALESCE(SUM(refund_due_amount) FILTER (WHERE booking_status = 'CANCELLED'), 0) AS refunds_due,
         COALESCE(SUM(forfeited_amount) FILTER (WHERE booking_status = 'CANCELLED'), 0) AS forfeited_charges
       FROM crm_bookings
       WHERE cancelled_at BETWEEN $1::timestamptz AND $2::timestamptz`,
      [fromTs, toTs]
    ),
  ]);

  const daily = dailyRes.rows.map((r) => ({
    day: r.day,
    rides_count: Number(r.rides_count),
    gmv: round2(r.gmv),
    pre_gst_fare: round2(r.pre_gst_fare),
    ride_gst: round2(r.ride_gst),
    commission_revenue: round2(r.commission_revenue),
    tech_fee_revenue: round2(r.tech_fee_revenue),
    commission_gst: round2(r.commission_gst),
    driver_payout: round2(r.driver_payout),
    cash_collected: round2(r.cash_collected),
    advance_online: round2(r.advance_online),
  }));

  const totals = daily.reduce(
    (acc, d) => {
      acc.rides_count += d.rides_count;
      acc.gmv = round2(acc.gmv + d.gmv);
      acc.pre_gst_fare = round2(acc.pre_gst_fare + d.pre_gst_fare);
      acc.ride_gst = round2(acc.ride_gst + d.ride_gst);
      acc.commission_revenue = round2(acc.commission_revenue + d.commission_revenue);
      acc.tech_fee_revenue = round2(acc.tech_fee_revenue + d.tech_fee_revenue);
      acc.commission_gst = round2(acc.commission_gst + d.commission_gst);
      acc.driver_payout = round2(acc.driver_payout + d.driver_payout);
      acc.cash_collected = round2(acc.cash_collected + d.cash_collected);
      acc.advance_online = round2(acc.advance_online + d.advance_online);
      return acc;
    },
    {
      rides_count: 0,
      gmv: 0,
      pre_gst_fare: 0,
      ride_gst: 0,
      commission_revenue: 0,
      tech_fee_revenue: 0,
      commission_gst: 0,
      driver_payout: 0,
      cash_collected: 0,
      advance_online: 0,
    }
  );

  const incentives_paid = round2(incentivesRes.rows[0]?.total_incentives);
  const cancellations_count = Number(cancellationsRes.rows[0]?.cancellations_count || 0);
  const refunds_due = round2(cancellationsRes.rows[0]?.refunds_due);
  const forfeited_charges = round2(cancellationsRes.rows[0]?.forfeited_charges);
  const total_gst_liability = round2(totals.ride_gst + totals.commission_gst);
  const net_platform_revenue = computeNetPlatformRevenue({
    commissionRevenue: totals.commission_revenue,
    techFeeRevenue: totals.tech_fee_revenue,
    forfeitedCharges: forfeited_charges,
    incentivesPaid: incentives_paid,
  });

  return {
    report: 'pnl' as const,
    range,
    summary: {
      ...totals,
      total_gst_liability,
      incentives_paid,
      cancellations_count,
      refunds_due,
      forfeited_charges,
      net_platform_revenue,
    },
    rows: daily,
  };
}

// ==============================================================================
// 2. GSTR-1 Ready Sales & Tax Register
// ==============================================================================
export async function getGstr1Register(range: DateRange) {
  const fromTs = `${range.from}T00:00:00+05:30`;
  const toTs = `${range.to}T23:59:59.999+05:30`;

  const billingInfo = await getSetting<{ hsn_sac?: string }>('company_billing_info', {});
  const hsnSac = String(billingInfo?.hsn_sac || '996412');

  const res = await query(
    `SELECT
       i.id,
       i.invoice_number,
       TO_CHAR((i.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS invoice_date,
       b.booking_code,
       b.origin_city,
       b.destination_city,
       c.full_name AS customer_name,
       COALESCE(NULLIF(TRIM(c.gstin), ''), '') AS customer_gstin,
       i.supplier_state_code,
       i.place_of_supply_code,
       i.place_of_supply_basis,
       i.subtotal AS taxable_value,
       COALESCE(i.cgst_amount, 0) AS cgst_amount,
       COALESCE(i.sgst_amount, 0) AS sgst_amount,
       COALESCE(i.igst_amount, 0) AS igst_amount,
       i.tax_amount AS total_tax,
       i.total_amount AS invoice_total
     FROM crm_invoices i
     JOIN crm_bookings b ON b.id = i.booking_id
     JOIN crm_customers c ON c.id = b.customer_id
     WHERE i.created_at BETWEEN $1::timestamptz AND $2::timestamptz
     ORDER BY i.created_at ASC, i.id ASC`,
    [fromTs, toTs]
  );

  const rows = res.rows.map((r) => {
    const isB2B = Boolean(r.customer_gstin && r.customer_gstin.length === 15);
    return {
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      booking_code: r.booking_code,
      supply_type: isB2B ? 'B2B' : 'B2C',
      customer_name: r.customer_name,
      customer_gstin: r.customer_gstin || '',
      origin_city: r.origin_city,
      place_of_supply_code: r.place_of_supply_code || 'PENDING',
      hsn_sac: hsnSac,
      taxable_value: round2(r.taxable_value),
      cgst_amount: round2(r.cgst_amount),
      sgst_amount: round2(r.sgst_amount),
      igst_amount: round2(r.igst_amount),
      total_tax: round2(r.total_tax),
      invoice_total: round2(r.invoice_total),
    };
  });

  const summary = rows.reduce(
    (acc, r) => {
      acc.invoice_count += 1;
      if (r.supply_type === 'B2B') acc.b2b_count += 1;
      else acc.b2c_count += 1;
      if (r.place_of_supply_code === 'PENDING') acc.pending_pos_count += 1;
      acc.taxable_value = round2(acc.taxable_value + r.taxable_value);
      acc.cgst_amount = round2(acc.cgst_amount + r.cgst_amount);
      acc.sgst_amount = round2(acc.sgst_amount + r.sgst_amount);
      acc.igst_amount = round2(acc.igst_amount + r.igst_amount);
      acc.total_tax = round2(acc.total_tax + r.total_tax);
      acc.invoice_total = round2(acc.invoice_total + r.invoice_total);
      return acc;
    },
    {
      invoice_count: 0,
      b2b_count: 0,
      b2c_count: 0,
      pending_pos_count: 0,
      taxable_value: 0,
      cgst_amount: 0,
      sgst_amount: 0,
      igst_amount: 0,
      total_tax: 0,
      invoice_total: 0,
    }
  );

  return { report: 'gstr1' as const, range, summary, rows };
}

// ==============================================================================
// 3. Driver Dues Aging & Credit Exposure Report (AR Aging)
// ==============================================================================
export async function getDriverDuesAgingReport() {
  const limitSetting = await getSetting<{ value?: number }>('driver_max_negative_balance_limit', { value: 1500 });
  const creditLimit = Number(limitSetting?.value ?? 1500);

  const res = await query(
    `SELECT
       d.id AS driver_id,
       d.full_name,
       d.phone,
       d.base_city,
       d.onboarding_status,
       ABS(d.wallet_balance) AS amount_owed,
       d.security_reserve_balance,
       d.last_dues_reminder_sent_at,
       COALESCE(
         (SELECT MAX(l.created_at) FROM crm_payments_ledger l
          WHERE l.driver_id = d.id AND l.direction = 'DEBIT'),
         d.updated_at
       ) AS latest_debit_at,
       COALESCE(
         (SELECT MIN(l.created_at) FROM crm_payments_ledger l
          WHERE l.driver_id = d.id AND l.direction = 'DEBIT'
            AND l.created_at > COALESCE(
              (SELECT MAX(l2.created_at) FROM crm_payments_ledger l2
               WHERE l2.driver_id = d.id AND l2.transaction_type IN ('DRIVER_DUES_PAYMENT', 'DUES_REPAYMENT')),
              '-infinity'::timestamptz
            )),
         d.updated_at
       ) AS oldest_unpaid_debit_at
     FROM crm_drivers d
     WHERE d.wallet_balance < 0
     ORDER BY ABS(d.wallet_balance) DESC`
  );

  const nowMs = Date.now();
  const buckets = { '0-7d': 0, '8-15d': 0, '16-30d': 0, '30+d': 0 };
  let total_owed = 0;
  let over_limit_count = 0;

  const rows = res.rows.map((r) => {
    const owed = round2(r.amount_owed);
    const oldestMs = r.oldest_unpaid_debit_at ? Date.parse(r.oldest_unpaid_debit_at) : nowMs;
    const daysOverdue = Math.max(0, Math.floor((nowMs - oldestMs) / (1000 * 60 * 60 * 24)));
    const bucket = classifyAgingBucket(daysOverdue);
    const overLimit = owed >= creditLimit;

    buckets[bucket] = round2(buckets[bucket] + owed);
    total_owed = round2(total_owed + owed);
    if (overLimit) over_limit_count += 1;

    return {
      driver_id: Number(r.driver_id),
      full_name: r.full_name,
      phone: r.phone,
      base_city: r.base_city || '—',
      onboarding_status: r.onboarding_status,
      amount_owed: owed,
      credit_limit: creditLimit,
      over_limit: overLimit,
      days_overdue: daysOverdue,
      aging_bucket: bucket,
      security_reserve_balance: round2(r.security_reserve_balance),
      oldest_unpaid_debit_at: r.oldest_unpaid_debit_at ? new Date(r.oldest_unpaid_debit_at).toISOString() : null,
    };
  });

  return {
    report: 'dues_aging' as const,
    summary: {
      drivers_owing_count: rows.length,
      over_limit_count,
      credit_limit: creditLimit,
      total_owed,
      buckets,
    },
    rows,
  };
}

// ==============================================================================
// 4. Driver Settlement & Payout Statement
// ==============================================================================
export async function getDriverSettlementReport(range: DateRange) {
  const fromTs = `${range.from}T00:00:00+05:30`;
  const toTs = `${range.to}T23:59:59.999+05:30`;

  const res = await query(
    `WITH trip_stats AS (
       SELECT
         assigned_driver_id AS driver_id,
         COUNT(*)::int AS completed_trips,
         COALESCE(SUM(customer_total_fare), 0) AS gross_fare,
         COALESCE(SUM(driver_payout_amount), 0) AS driver_earnings,
         COALESCE(SUM(commission_amount), 0) AS commission_deducted,
         COALESCE(SUM(cash_collected_by_driver), 0) AS cash_collected
       FROM crm_bookings
       WHERE assigned_driver_id IS NOT NULL
         AND booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')
         AND created_at BETWEEN $1::timestamptz AND $2::timestamptz
       GROUP BY assigned_driver_id
     ),
     ledger_stats AS (
       SELECT
         driver_id,
         COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('INCENTIVE_BONUS', 'INCENTIVE_STREAK_BONUS')), 0) AS incentives,
         COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'DRIVER_PAYOUT_SENT'), 0) AS payouts_sent,
         COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('DRIVER_DUES_PAYMENT', 'DUES_REPAYMENT')), 0) AS dues_collected
       FROM crm_payments_ledger
       WHERE driver_id IS NOT NULL
         AND created_at BETWEEN $1::timestamptz AND $2::timestamptz
       GROUP BY driver_id
     )
     SELECT
       d.id AS driver_id,
       d.full_name,
       d.phone,
       d.base_city,
       d.wallet_balance,
       d.security_reserve_balance,
       COALESCE(t.completed_trips, 0) AS completed_trips,
       COALESCE(t.gross_fare, 0) AS gross_fare,
       COALESCE(t.driver_earnings, 0) AS driver_earnings,
       COALESCE(t.commission_deducted, 0) AS commission_deducted,
       COALESCE(t.cash_collected, 0) AS cash_collected,
       COALESCE(l.incentives, 0) AS incentives,
       COALESCE(l.payouts_sent, 0) AS payouts_sent,
       COALESCE(l.dues_collected, 0) AS dues_collected
     FROM crm_drivers d
     LEFT JOIN trip_stats t ON t.driver_id = d.id
     LEFT JOIN ledger_stats l ON l.driver_id = d.id
     WHERE COALESCE(t.completed_trips, 0) > 0
        OR COALESCE(l.payouts_sent, 0) > 0
        OR COALESCE(l.dues_collected, 0) > 0
        OR COALESCE(l.incentives, 0) > 0
        OR d.wallet_balance <> 0
     ORDER BY COALESCE(t.completed_trips, 0) DESC, ABS(d.wallet_balance) DESC`,
    [fromTs, toTs]
  );

  const rows = res.rows.map((r) => ({
    driver_id: Number(r.driver_id),
    full_name: r.full_name,
    phone: r.phone,
    base_city: r.base_city || '—',
    completed_trips: Number(r.completed_trips),
    gross_fare: round2(r.gross_fare),
    driver_earnings: round2(r.driver_earnings),
    commission_deducted: round2(r.commission_deducted),
    cash_collected: round2(r.cash_collected),
    incentives: round2(r.incentives),
    payouts_sent: round2(r.payouts_sent),
    dues_collected: round2(r.dues_collected),
    wallet_balance: round2(r.wallet_balance),
    security_reserve_balance: round2(r.security_reserve_balance),
  }));

  const summary = rows.reduce(
    (acc, r) => {
      acc.drivers_count += 1;
      acc.completed_trips += r.completed_trips;
      acc.driver_earnings = round2(acc.driver_earnings + r.driver_earnings);
      acc.payouts_sent = round2(acc.payouts_sent + r.payouts_sent);
      acc.dues_collected = round2(acc.dues_collected + r.dues_collected);
      if (r.wallet_balance > 0) acc.total_payable_to_drivers = round2(acc.total_payable_to_drivers + r.wallet_balance);
      if (r.wallet_balance < 0) acc.total_receivable_from_drivers = round2(acc.total_receivable_from_drivers + Math.abs(r.wallet_balance));
      return acc;
    },
    {
      drivers_count: 0,
      completed_trips: 0,
      driver_earnings: 0,
      payouts_sent: 0,
      dues_collected: 0,
      total_payable_to_drivers: 0,
      total_receivable_from_drivers: 0,
    }
  );

  return { report: 'settlements' as const, range, summary, rows };
}

// ==============================================================================
// 5. Online Payments, Refunds & Cancellation Charges Reconciliation
// ==============================================================================
export async function getReconciliationReport(range: DateRange) {
  const fromTs = `${range.from}T00:00:00+05:30`;
  const toTs = `${range.to}T23:59:59.999+05:30`;

  const [linksRes, refundsRes, chargesRes] = await Promise.all([
    query(
      `SELECT
         pl.id,
         pl.provider,
         pl.provider_link_id,
         pl.provider_payment_id,
         pl.purpose,
         pl.status,
         pl.amount_paise,
         pl.receipt_voucher_number,
         b.booking_code,
         d.full_name AS driver_name,
         TO_CHAR((pl.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:MI') AS created_ist
       FROM crm_payment_links pl
       LEFT JOIN crm_bookings b ON b.id = pl.booking_id
       LEFT JOIN crm_drivers d ON d.id = pl.driver_id
       WHERE pl.created_at BETWEEN $1::timestamptz AND $2::timestamptz
       ORDER BY pl.created_at DESC`,
      [fromTs, toTs]
    ),
    query(
      `SELECT
         r.id,
         b.booking_code,
         r.status,
         r.amount_paise,
         r.provider_payment_id,
         r.provider_refund_id,
         r.refund_voucher_number,
         r.reason,
         TO_CHAR((r.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:MI') AS created_ist
       FROM crm_refunds r
       JOIN crm_bookings b ON b.id = r.booking_id
       WHERE r.created_at BETWEEN $1::timestamptz AND $2::timestamptz
       ORDER BY r.created_at DESC`,
      [fromTs, toTs]
    ),
    query(
      `SELECT
         cc.id,
         b.booking_code,
         cc.amount,
         cc.status,
         cc.invoice_number,
         cc.gst_amount,
         TO_CHAR((cc.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:MI') AS created_ist
       FROM crm_cancellation_charges cc
       JOIN crm_bookings b ON b.id = cc.booking_id
       WHERE cc.created_at BETWEEN $1::timestamptz AND $2::timestamptz
       ORDER BY cc.created_at DESC`,
      [fromTs, toTs]
    ),
  ]);

  const rows: Array<{
    record_type: 'PAYMENT_LINK' | 'REFUND' | 'CANCELLATION_CHARGE';
    created_ist: string;
    booking_code: string;
    party: string;
    status: string;
    amount: number;
    provider_ref: string;
    voucher_or_invoice: string;
    notes: string;
  }> = [];

  let paid_online_total = 0;
  let pending_links_total = 0;
  let refunds_processed_total = 0;
  let refunds_pending_total = 0;
  let cancellation_charges_total = 0;

  for (const l of linksRes.rows) {
    const amt = round2(Number(l.amount_paise || 0) / 100);
    if (l.status === 'PAID') paid_online_total = round2(paid_online_total + amt);
    else if (l.status === 'CREATED') pending_links_total = round2(pending_links_total + amt);

    rows.push({
      record_type: 'PAYMENT_LINK',
      created_ist: l.created_ist,
      booking_code: l.booking_code || '—',
      party: l.driver_name || l.purpose || 'Online',
      status: l.status,
      amount: amt,
      provider_ref: l.provider_payment_id || l.provider_link_id || '—',
      voucher_or_invoice: l.receipt_voucher_number || '—',
      notes: l.purpose || '',
    });
  }

  for (const r of refundsRes.rows) {
    const amt = round2(Number(r.amount_paise || 0) / 100);
    if (r.status === 'PROCESSED') refunds_processed_total = round2(refunds_processed_total + amt);
    else refunds_pending_total = round2(refunds_pending_total + amt);

    rows.push({
      record_type: 'REFUND',
      created_ist: r.created_ist,
      booking_code: r.booking_code || '—',
      party: 'Customer Refund',
      status: r.status,
      amount: -amt,
      provider_ref: r.provider_refund_id || r.provider_payment_id || '—',
      voucher_or_invoice: r.refund_voucher_number || '—',
      notes: r.reason || '',
    });
  }

  for (const c of chargesRes.rows) {
    const amt = round2(c.amount);
    cancellation_charges_total = round2(cancellation_charges_total + amt);

    rows.push({
      record_type: 'CANCELLATION_CHARGE',
      created_ist: c.created_ist,
      booking_code: c.booking_code || '—',
      party: 'Forfeited Advance',
      status: c.status,
      amount: amt,
      provider_ref: '—',
      voucher_or_invoice: c.invoice_number || 'PENDING_RATE',
      notes: c.gst_amount ? `GST ₹${round2(c.gst_amount)}` : '',
    });
  }

  return {
    report: 'reconciliation' as const,
    range,
    summary: {
      total_records: rows.length,
      paid_online_total,
      pending_links_total,
      refunds_processed_total,
      refunds_pending_total,
      cancellation_charges_total,
    },
    rows,
  };
}

// ==============================================================================
// CSV Builders
// ==============================================================================
export function formatReportAsCsv(
  report: FinancialReportType,
  data: any
): { filename: string; csv: string } {
  const suffix = data.range ? `${data.range.from}-to-${data.range.to}` : new Date().toISOString().slice(0, 10);

  switch (report) {
    case 'pnl':
      return {
        filename: `biharcabs-pnl-${suffix}.csv`,
        csv: toCsv(
          [
            'Date (IST)',
            'Completed Rides',
            'GMV (INR)',
            'Pre-GST Fare (INR)',
            'Ride GST 5% (INR)',
            'Commission Revenue (INR)',
            'Tech Fee Revenue (INR)',
            'Commission GST 18% (INR)',
            'Driver Payout (INR)',
            'Cash Collected (INR)',
            'Advance Online (INR)',
          ],
          (data.rows || []).map((r: any) => [
            r.day,
            r.rides_count,
            r.gmv,
            r.pre_gst_fare,
            r.ride_gst,
            r.commission_revenue,
            r.tech_fee_revenue,
            r.commission_gst,
            r.driver_payout,
            r.cash_collected,
            r.advance_online,
          ])
        ),
      };

    case 'gstr1':
      return {
        filename: `biharcabs-gstr1-${suffix}.csv`,
        csv: toCsv(
          [
            'Invoice Number',
            'Invoice Date',
            'Booking Code',
            'Supply Type',
            'Customer Name',
            'Customer GSTIN',
            'Origin City',
            'Place of Supply Code',
            'HSN/SAC',
            'Taxable Value (INR)',
            'CGST (INR)',
            'SGST (INR)',
            'IGST (INR)',
            'Total Tax (INR)',
            'Invoice Total (INR)',
          ],
          (data.rows || []).map((r: any) => [
            r.invoice_number,
            r.invoice_date,
            r.booking_code,
            r.supply_type,
            r.customer_name,
            r.customer_gstin,
            r.origin_city,
            r.place_of_supply_code,
            r.hsn_sac,
            r.taxable_value,
            r.cgst_amount,
            r.sgst_amount,
            r.igst_amount,
            r.total_tax,
            r.invoice_total,
          ])
        ),
      };

    case 'dues_aging':
      return {
        filename: `biharcabs-driver-dues-aging-${suffix}.csv`,
        csv: toCsv(
          [
            'Driver ID',
            'Driver Name',
            'Phone',
            'Base City',
            'Status',
            'Amount Owed (INR)',
            'Credit Limit (INR)',
            'Over Limit',
            'Days Overdue',
            'Aging Bucket',
            'Security Reserve (INR)',
          ],
          (data.rows || []).map((r: any) => [
            r.driver_id,
            r.full_name,
            r.phone,
            r.base_city,
            r.onboarding_status,
            r.amount_owed,
            r.credit_limit,
            r.over_limit ? 'YES' : 'NO',
            r.days_overdue,
            r.aging_bucket,
            r.security_reserve_balance,
          ])
        ),
      };

    case 'settlements':
      return {
        filename: `biharcabs-driver-settlements-${suffix}.csv`,
        csv: toCsv(
          [
            'Driver ID',
            'Driver Name',
            'Phone',
            'Base City',
            'Completed Trips',
            'Gross Fare (INR)',
            'Driver Earnings (INR)',
            'Commission Deducted (INR)',
            'Cash Collected (INR)',
            'Incentives (INR)',
            'Payouts Sent (INR)',
            'Dues Collected (INR)',
            'Current Wallet Balance (INR)',
            'Security Reserve (INR)',
          ],
          (data.rows || []).map((r: any) => [
            r.driver_id,
            r.full_name,
            r.phone,
            r.base_city,
            r.completed_trips,
            r.gross_fare,
            r.driver_earnings,
            r.commission_deducted,
            r.cash_collected,
            r.incentives,
            r.payouts_sent,
            r.dues_collected,
            r.wallet_balance,
            r.security_reserve_balance,
          ])
        ),
      };

    case 'reconciliation':
      return {
        filename: `biharcabs-reconciliation-${suffix}.csv`,
        csv: toCsv(
          [
            'Type',
            'Timestamp (IST)',
            'Booking Code',
            'Party / Purpose',
            'Status',
            'Amount (INR)',
            'Provider Reference',
            'Voucher / Invoice',
            'Notes',
          ],
          (data.rows || []).map((r: any) => [
            r.record_type,
            r.created_ist,
            r.booking_code,
            r.party,
            r.status,
            r.amount,
            r.provider_ref,
            r.voucher_or_invoice,
            r.notes,
          ])
        ),
      };
  }
}
