import { query } from './db';
import { getSetting, updateSetting } from './settings';
import { sendWhatsAppText } from './whatsapp';
import { computeNetPlatformRevenue } from './financial-reports';

export type DigestSlot = 'MORNING' | 'EVENING';

export interface FounderDigestConfig {
  enabled: boolean;
  phones: string[];
  morning_hour_ist: number;
  evening_hour_ist: number;
  last_morning_sent_date: string | null;
  last_evening_sent_date: string | null;
}

const DEFAULT_CONFIG: FounderDigestConfig = {
  enabled: true,
  phones: [],
  morning_hour_ist: 8,
  evening_hour_ist: 20,
  last_morning_sent_date: null,
  last_evening_sent_date: null,
};

export interface IstClock {
  dateStr: string;      // YYYY-MM-DD in IST
  yesterdayStr: string; // YYYY-MM-DD in IST
  tomorrowStr: string;  // YYYY-MM-DD in IST
  hour: number;         // 0..23 in IST
}

export function getIstClock(now = new Date()): IstClock {
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const yest = new Date(istMs - 86400_000);
  const tom = new Date(istMs + 86400_000);
  return {
    dateStr: ist.toISOString().slice(0, 10),
    yesterdayStr: yest.toISOString().slice(0, 10),
    tomorrowStr: tom.toISOString().slice(0, 10),
    hour: ist.getUTCHours(),
  };
}

/**
 * Determine which digest slot (if any) is due right now in IST.
 * Idempotent per date: each slot fires at most once per IST day.
 */
export function resolveDueDigestSlot(
  config: FounderDigestConfig,
  clock: IstClock
): DigestSlot | null {
  if (!config.enabled) return null;

  const morningHr = Math.min(23, Math.max(0, Number(config.morning_hour_ist ?? 8)));
  const eveningHr = Math.min(23, Math.max(0, Number(config.evening_hour_ist ?? 20)));

  if (clock.hour >= eveningHr && config.last_evening_sent_date !== clock.dateStr) {
    return 'EVENING';
  }
  if (clock.hour >= morningHr && clock.hour < eveningHr && config.last_morning_sent_date !== clock.dateStr) {
    return 'MORNING';
  }
  return null;
}

export async function getFounderDigestConfig(): Promise<FounderDigestConfig> {
  const raw = await getSetting<Partial<FounderDigestConfig>>('founder_whatsapp_digest', {});
  const phones = Array.isArray(raw?.phones)
    ? raw.phones.map((p) => String(p || '').replace(/\D/g, '')).filter(Boolean)
    : [];
  return {
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : DEFAULT_CONFIG.enabled,
    phones,
    morning_hour_ist: Number.isInteger(Number(raw?.morning_hour_ist)) ? Number(raw?.morning_hour_ist) : 8,
    evening_hour_ist: Number.isInteger(Number(raw?.evening_hour_ist)) ? Number(raw?.evening_hour_ist) : 20,
    last_morning_sent_date: typeof raw?.last_morning_sent_date === 'string' ? raw.last_morning_sent_date : null,
    last_evening_sent_date: typeof raw?.last_evening_sent_date === 'string' ? raw.last_evening_sent_date : null,
  };
}

export async function resolveDigestRecipients(config: FounderDigestConfig): Promise<string[]> {
  if (config.phones.length > 0) return Array.from(new Set(config.phones));
  const escalation = await getSetting<Array<{ phone?: string }>>('admin_escalation_contacts', []);
  if (!Array.isArray(escalation)) return [];
  return Array.from(
    new Set(
      escalation
        .map((c) => String(c?.phone || '').replace(/\D/g, ''))
        .filter((p) => p.length >= 10)
    )
  );
}

export interface ScheduledBookingItem {
  bookingCode: string;
  pickupTime: string;
  originCity: string;
  destinationCity: string | null;
  customerName: string;
  driverName: string | null;
  bookingStatus: string;
}

export interface FounderDigestSummary {
  slot: DigestSlot;
  periodLabel: string;
  periodDate: string;
  upcomingLabel: string;
  upcomingDate: string;
  totalBookings: number;
  completedRides: number;
  activeOrAssignedRides: number;
  unassignedNow: number;
  cancelledRides: number;
  gmv: number;
  gstLiability: number;
  netPlatformRevenue: number;
  topCity: string | null;
  upcomingPickupsCount: number;
  upcomingBookings: ScheduledBookingItem[];
  overdueDuesTotal: number;
  driversOwingCount: number;
  expiringDocsCount: number;
  openFailedMessages: number;
}

function round2(n: unknown): number {
  const v = Number(n || 0);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

export async function buildFounderDigestSummary(
  slot: DigestSlot,
  now = new Date()
): Promise<FounderDigestSummary> {
  const clock = getIstClock(now);
  const periodDate = slot === 'MORNING' ? clock.yesterdayStr : clock.dateStr;
  const upcomingDate = slot === 'MORNING' ? clock.dateStr : clock.tomorrowStr;
  const fromTs = `${periodDate}T00:00:00+05:30`;
  const toTs = `${periodDate}T23:59:59.999+05:30`;

  const [bookingsRes, incentivesRes, topCityRes, upcomingRes, riskRes] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int AS total_bookings,
         COUNT(*) FILTER (WHERE booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED'))::int AS completed_rides,
         COUNT(*) FILTER (WHERE booking_status IN ('DRIVER_ASSIGNED', 'TRIP_STARTED'))::int AS active_rides,
         COUNT(*) FILTER (WHERE booking_status = 'CANCELLED')::int AS cancelled_rides,
         COALESCE(SUM(customer_total_fare) FILTER (WHERE booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')), 0) AS gmv,
         COALESCE(SUM(ride_gst_amount + gst_amount) FILTER (WHERE booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')), 0) AS gst_liability,
         COALESCE(SUM(commission_amount) FILTER (WHERE booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')), 0) AS commission_rev,
         COALESCE(SUM(tech_fee_amount) FILTER (WHERE booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')), 0) AS tech_fee_rev,
         COALESCE(SUM(forfeited_amount) FILTER (WHERE booking_status = 'CANCELLED'), 0) AS forfeited_charges
       FROM crm_bookings
       WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz`,
      [fromTs, toTs]
    ),
    query(
      `SELECT COALESCE(SUM(amount), 0) AS incentives
       FROM crm_payments_ledger
       WHERE transaction_type IN ('INCENTIVE_BONUS', 'INCENTIVE_STREAK_BONUS')
         AND created_at BETWEEN $1::timestamptz AND $2::timestamptz`,
      [fromTs, toTs]
    ),
    query(
      `SELECT origin_city, COUNT(*)::int AS cnt
       FROM crm_bookings
       WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz
       GROUP BY origin_city
       ORDER BY cnt DESC
       LIMIT 1`,
      [fromTs, toTs]
    ),
    query(
      `SELECT
         b.booking_code,
         TO_CHAR(b.pickup_time, 'HH24:MI') AS pickup_hm,
         b.origin_city,
         b.destination_city,
         b.booking_status,
         COALESCE(c.full_name, c.phone) AS customer_name,
         d.full_name AS driver_name
       FROM crm_bookings b
       JOIN crm_customers c ON c.id = b.customer_id
       LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
       WHERE b.pickup_date = $1::date
         AND b.booking_status IN ('AWAITING_DRIVER', 'ESCALATED_NO_DRIVER', 'DRIVER_ASSIGNED', 'TRIP_STARTED')
       ORDER BY b.pickup_time ASC, b.id ASC`,
      [upcomingDate]
    ),
    query(
      `SELECT
         (SELECT COUNT(*)::int FROM crm_bookings WHERE booking_status = 'AWAITING_DRIVER') AS unassigned_now,
         (SELECT COALESCE(SUM(ABS(wallet_balance)), 0) FROM crm_drivers WHERE wallet_balance < 0) AS overdue_dues,
         (SELECT COUNT(*)::int FROM crm_drivers WHERE wallet_balance < 0) AS drivers_owing,
         (SELECT COUNT(*)::int FROM crm_notification_failures WHERE resolved_at IS NULL) AS open_failed_msgs,
         (
           SELECT COUNT(*)::int
           FROM crm_drivers d
           LEFT JOIN crm_driver_vehicles v ON v.driver_id = d.id
           WHERE d.onboarding_status = 'APPROVED_ACTIVE'
             AND (
               (d.license_expiry IS NOT NULL AND d.license_expiry <= CURRENT_DATE + INTERVAL '7 days')
               OR (v.insurance_expiry IS NOT NULL AND v.insurance_expiry <= CURRENT_DATE + INTERVAL '7 days')
               OR (v.permit_expiry IS NOT NULL AND v.permit_expiry <= CURRENT_DATE + INTERVAL '7 days')
               OR (v.puc_expiry IS NOT NULL AND v.puc_expiry <= CURRENT_DATE + INTERVAL '7 days')
             )
         ) AS expiring_docs`
    ),
  ]);

  const b = bookingsRes.rows[0] || {};
  const r = riskRes.rows[0] || {};
  const netPlatformRevenue = computeNetPlatformRevenue({
    commissionRevenue: round2(b.commission_rev),
    techFeeRevenue: round2(b.tech_fee_rev),
    forfeitedCharges: round2(b.forfeited_charges),
    incentivesPaid: round2(incentivesRes.rows[0]?.incentives),
  });

  const upcomingBookings: ScheduledBookingItem[] = upcomingRes.rows.map((u) => ({
    bookingCode: u.booking_code,
    pickupTime: String(u.pickup_hm || '').slice(0, 5),
    originCity: u.origin_city,
    destinationCity: u.destination_city || null,
    customerName: u.customer_name || 'Customer',
    driverName: u.driver_name || null,
    bookingStatus: u.booking_status,
  }));

  return {
    slot,
    periodLabel: slot === 'MORNING' ? `Yesterday (${periodDate})` : `Today so far (${periodDate})`,
    periodDate,
    upcomingLabel: slot === 'MORNING' ? `Today (${upcomingDate})` : `Tomorrow (${upcomingDate})`,
    upcomingDate,
    totalBookings: Number(b.total_bookings || 0),
    completedRides: Number(b.completed_rides || 0),
    activeOrAssignedRides: Number(b.active_rides || 0),
    unassignedNow: Number(r.unassigned_now || 0),
    cancelledRides: Number(b.cancelled_rides || 0),
    gmv: round2(b.gmv),
    gstLiability: round2(b.gst_liability),
    netPlatformRevenue: netPlatformRevenue,
    topCity: topCityRes.rows[0]?.origin_city || null,
    upcomingPickupsCount: upcomingBookings.length,
    upcomingBookings,
    overdueDuesTotal: round2(r.overdue_dues),
    driversOwingCount: Number(r.drivers_owing || 0),
    expiringDocsCount: Number(r.expiring_docs || 0),
    openFailedMessages: Number(r.open_failed_msgs || 0),
  };
}

function fmtInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatFounderDigestMessage(s: FounderDigestSummary): string {
  const header =
    s.slot === 'MORNING'
      ? `☀️ *BiharCabs Morning Founder Digest (8:00 AM)*`
      : `🌙 *BiharCabs Evening Founder Digest (8:00 PM)*`;

  const MAX_LISTED = 10;
  const scheduledLines: string[] = [];
  if (s.upcomingBookings && s.upcomingBookings.length > 0) {
    for (const item of s.upcomingBookings.slice(0, MAX_LISTED)) {
      const driverTag = item.driverName ? `Driver: ${item.driverName}` : '⚠️ UNASSIGNED';
      scheduledLines.push(
        `  • ${item.pickupTime} #${item.bookingCode} | ${item.originCity} → ${item.destinationCity || 'Local'} | ${item.customerName} (${driverTag})`
      );
    }
    if (s.upcomingBookings.length > MAX_LISTED) {
      scheduledLines.push(`  … and ${s.upcomingBookings.length - MAX_LISTED} more scheduled`);
    }
  } else {
    scheduledLines.push(`  • No pickups scheduled yet.`);
  }

  const lines = [
    header,
    `📅 *${s.periodLabel}*`,
    ``,
    `🚕 *Rides & Bookings*`,
    `• Total Bookings: ${s.totalBookings}`,
    `• Completed: ${s.completedRides} | Active/Assigned: ${s.activeOrAssignedRides} | Cancelled: ${s.cancelledRides}`,
    ...(s.topCity ? [`• Top Origin City: ${s.topCity}`] : []),
    ``,
    `💰 *Financial Snapshot*`,
    `• GMV (Completed): ${fmtInr(s.gmv)}`,
    `• Net Platform Revenue: ${fmtInr(s.netPlatformRevenue)}`,
    `• GST Liability: ${fmtInr(s.gstLiability)}`,
    ``,
    `🗓️ *Scheduled Pickups — ${s.upcomingLabel} (${s.upcomingPickupsCount})*`,
    ...scheduledLines,
    ``,
    `📋 *Live Ops Alerts*`,
    `• Unassigned Rides Right Now: ${s.unassignedNow}`,
    `• Driver Dues Owed: ${fmtInr(s.overdueDuesTotal)} (${s.driversOwingCount} driver${s.driversOwingCount === 1 ? '' : 's'})`,
    `• Fleet Docs Expiring (≤7d): ${s.expiringDocsCount}`,
    ...(s.openFailedMessages > 0 ? [`• ⚠️ Open Failed WA Messages: ${s.openFailedMessages}`] : []),
  ];

  return lines.join('\n');
}

export async function sendFounderDigest(
  slot: DigestSlot,
  now = new Date()
): Promise<{ sent: number; recipients: string[]; summary: FounderDigestSummary; message: string }> {
  const config = await getFounderDigestConfig();
  const recipients = await resolveDigestRecipients(config);
  const summary = await buildFounderDigestSummary(slot, now);
  const message = formatFounderDigestMessage(summary);

  let sent = 0;
  for (const phone of recipients) {
    try {
      const ok = await sendWhatsAppText(phone, message);
      if (ok) sent += 1;
    } catch (err: any) {
      console.error(`[FounderDigest] Failed sending ${slot} digest to ${phone}:`, err?.message);
    }
  }

  return { sent, recipients, summary, message };
}

/**
 * Called by executeFrequentCronTasks(): checks whether the 8:00 AM or 8:00 PM IST
 * Founder WhatsApp Digest is due and sends it at most once per slot per day.
 */
export async function runScheduledFounderDigest(
  now = new Date()
): Promise<{ slot: DigestSlot | null; sent: number }> {
  const config = await getFounderDigestConfig();
  const clock = getIstClock(now);
  const dueSlot = resolveDueDigestSlot(config, clock);
  if (!dueSlot) return { slot: null, sent: 0 };

  const result = await sendFounderDigest(dueSlot, now);

  // Mark slot sent for today so subsequent frequent cron runs won't repeat it
  const nextConfig: FounderDigestConfig = {
    ...config,
    last_morning_sent_date: dueSlot === 'MORNING' ? clock.dateStr : config.last_morning_sent_date,
    last_evening_sent_date: dueSlot === 'EVENING' ? clock.dateStr : config.last_evening_sent_date,
  };
  await updateSetting('founder_whatsapp_digest', nextConfig);

  return { slot: dueSlot, sent: result.sent };
}
