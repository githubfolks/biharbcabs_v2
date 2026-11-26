import { query } from './db';
import { purgeOldLoginAttempts } from './login-security';
import { reconcileStalePaymentLinks } from './razorpay-webhook';
import { syncDriverPlanSuspension } from './driver-plans';
import { runFailedMessageDigest } from './notification-failures';
import { sendPendingGstDocuments } from './gst-delivery';
import { syncFuelPricesFromApi } from './fuel-price-sync';
import {
  getDriverWakeupCheckHours,
  getWakeupUnconfirmedAlertMinutes,
  getCompanyBillingInfo,
  getRevenueProtectionPolicy,
  getSetting,
} from './settings';
import {
  broadcastRideToDrivers,
  checkAndEscalateSlaBreaches,
  BookingDetails,
  releaseExpiredReturnWindows,
} from './dispatch-engine';
import { notifyOfferedDrivers } from './dispatch-notify';
import { notify, notifyAdmins } from './wa-notify';
import { expireDriverReturns } from './return-trips';
import { sendWhatsAppText, sendWhatsAppButtons } from './whatsapp';
import { recordBookingEvent } from './booking-timeline';

export interface FrequentCronResult {
  ridesRebroadcasted: number;
  slaBreachesEscalated: number;
  wakeupChecksSent: number;
  unconfirmedWakeupAlerts: number;
  documentsExpiredSuspended: number;
  unpaidDuesSuspended: number;
  returnWindowsReleased: number;
  driverReturnsExpired: number;
  paymentLinksClosed: number;
  paymentLinkPaidAlerts: number;
  failedMessagesReported: number;
  gstDocumentsSent: number;
  gstDocumentsFailed: number;
}

export interface DailyCronResult {
  documentsExpiringWarned: number;
  loginAttemptsPurged: number;
  cancellationDocumentsIssued: number;
  fuelPricesSynced: boolean;
}

/**
 * 0. Auto-Rebroadcast Unassigned Rides (before SLA breach)
 * Reaches newly free drivers if a booking stays in AWAITING_DRIVER past the configured threshold.
 */
export async function runUnassignedRideRebroadcast(): Promise<number> {
  const policy = await getSetting<{ enabled?: boolean; after_minutes?: number; max_rebroadcasts?: number }>(
    'unassigned_rebroadcast_policy',
    { enabled: true, after_minutes: 5, max_rebroadcasts: 1 }
  );
  if (policy?.enabled === false) return 0;

  const afterMinutes = Math.max(1, Number(policy?.after_minutes ?? 5));
  const maxRebroadcasts = Math.max(0, Number(policy?.max_rebroadcasts ?? 1));
  if (maxRebroadcasts === 0) return 0;

  const candidates = await query(
    `SELECT id, booking_code, origin_city, destination_city, auto_rebroadcast_count
     FROM crm_bookings
     WHERE booking_status = 'AWAITING_DRIVER'
       AND assigned_driver_id IS NULL
       AND auto_rebroadcast_count < $1
       AND COALESCE(last_rebroadcast_at, driver_broadcast_at, created_at) <= CURRENT_TIMESTAMP - ($2 * INTERVAL '1 minute')
       AND ((pickup_date + pickup_time) AT TIME ZONE 'Asia/Kolkata') > CURRENT_TIMESTAMP
     ORDER BY created_at ASC
     LIMIT 20`,
    [maxRebroadcasts, afterMinutes]
  );

  let rebroadcasted = 0;
  for (const row of candidates.rows) {
    const bookingId = Number(row.id);
    try {
      const dispatchResult = await broadcastRideToDrivers(bookingId);
      await query(
        `UPDATE crm_bookings
         SET auto_rebroadcast_count = auto_rebroadcast_count + 1,
             last_rebroadcast_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [bookingId]
      );
      if (dispatchResult.offersCreated > 0) {
        await notifyOfferedDrivers(bookingId, dispatchResult);
        rebroadcasted += 1;
      }
      await recordBookingEvent({
        bookingId,
        eventType: 'AUTO_REBROADCAST',
        actorType: 'SYSTEM',
        actorLabel: 'Dispatch Cron',
        summary:
          dispatchResult.offersCreated > 0
            ? `Auto-rebroadcast wave #${Number(row.auto_rebroadcast_count) + 1} sent to ${dispatchResult.offersCreated} additional driver(s)`
            : `Auto-rebroadcast wave #${Number(row.auto_rebroadcast_count) + 1} checked — no new eligible drivers available`,
        metadata: { wave: Number(row.auto_rebroadcast_count) + 1, offersCreated: dispatchResult.offersCreated },
      });
    } catch (err: any) {
      console.error(`[Cron] Auto-rebroadcast failed for booking #${row.booking_code}:`, err?.message);
    }
  }
  return rebroadcasted;
}

/**
 * 1. SLA Breach Escalation
 */
export async function runSlaEscalation(): Promise<BookingDetails[]> {
  const breachedBookings = await checkAndEscalateSlaBreaches();
  for (const booking of breachedBookings) {
    await notifyAdmins(`⚠️ SLA Alert: Booking #${booking.booking_code} (${booking.origin_city} → ${booking.destination_city || 'Local'}) on ${booking.pickup_date} at ${booking.pickup_time} has NOT been confirmed by any driver! Assign it manually in the CRM.`);
  }

  return breachedBookings;
}

/**
 * 2. T-2h Driver Wake-up & Readiness Check
 */
export async function runDriverWakeupChecks(): Promise<number> {
  const hoursBefore = await getDriverWakeupCheckHours();

  // Find bookings assigned to drivers starting within hoursBefore hours where wakeup check hasn't been sent yet
  const sql = `
    SELECT 
      b.id, b.booking_code, b.pickup_date, b.pickup_time, b.pickup_address,
      d.full_name AS driver_name, d.phone AS driver_phone, d.whatsapp_phone
    FROM crm_bookings b
    JOIN crm_drivers d ON d.id = b.assigned_driver_id
    WHERE b.booking_status = 'DRIVER_ASSIGNED'
      AND b.wakeup_sent_at IS NULL
      -- Pickup times are India local; compare full timestamps (no midnight wrap, no dependence on the
      -- database time zone) and skip pickups already past.
      AND ((b.pickup_date + b.pickup_time) AT TIME ZONE 'Asia/Kolkata') <= CURRENT_TIMESTAMP + ($1 * INTERVAL '1 hour')
      AND ((b.pickup_date + b.pickup_time) AT TIME ZONE 'Asia/Kolkata') > CURRENT_TIMESTAMP
    LIMIT 50;
  `;

  const res = await query(sql, [hoursBefore]);
  let sentCount = 0;

  for (const b of res.rows) {
    const targetPhone = b.whatsapp_phone || b.driver_phone;
    if (targetPhone) {
      const when = `${new Date(b.pickup_date).toLocaleDateString('en-IN')} ${String(b.pickup_time).slice(0, 5)}`;
      await notify(targetPhone, 'driver_wakeup', {
        ref: Number(b.id),
        params: [`#${b.booking_code}`, when, b.pickup_address],
        freeform: () =>
          sendWhatsAppButtons(
            targetPhone,
            `⏰ Upcoming Pickup Reminder (#${b.booking_code}) on ${when}!\nPickup: ${b.pickup_address}\n\nPlease tap below to confirm you are awake, vehicle is ready, and you will arrive on time:`,
            [{ id: `wakeup_ready_${b.id}`, title: '⏰ I Am Ready & On Time' }],
            'BiharCabs Driver Wake-up Check'
          ),
      });

      await query(
        `UPDATE crm_bookings SET wakeup_sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [b.id]
      );
      await recordBookingEvent({
        bookingId: Number(b.id),
        eventType: 'WAKEUP_SENT',
        actorType: 'SYSTEM',
        actorLabel: 'Wake-up Cron',
        summary: `T-${hoursBefore}h wake-up check sent to driver ${b.driver_name || targetPhone}`,
        metadata: { hoursBefore },
      });
      sentCount++;
    }
  }

  return sentCount;
}

/** Time a driver has to answer the wake-up check before an unconfirmed alert can go out. */
const WAKEUP_ANSWER_MINUTES = 15;

/**
 * 2B. Unconfirmed wake-up: the assigned driver has not tapped "I am ready" and pickup is within
 * driver_wakeup_unconfirmed_alert_minutes (60). Admins are alerted once per booking (claimed atomically),
 * so they can call the driver or reassign the ride.
 */
export async function runUnconfirmedWakeupAlerts(): Promise<number> {
  const minutes = await getWakeupUnconfirmedAlertMinutes();
  const claimed = await query(
    `UPDATE crm_bookings b SET wakeup_alerted_at = CURRENT_TIMESTAMP
     FROM crm_drivers d
     WHERE d.id = b.assigned_driver_id
       AND b.booking_status = 'DRIVER_ASSIGNED'
       AND b.wakeup_sent_at IS NOT NULL AND b.wakeup_confirmed_at IS NULL AND b.wakeup_alerted_at IS NULL
       AND b.wakeup_sent_at <= CURRENT_TIMESTAMP - ($2 * INTERVAL '1 minute')
       AND ((b.pickup_date + b.pickup_time) AT TIME ZONE 'Asia/Kolkata') <= CURRENT_TIMESTAMP + ($1 * INTERVAL '1 minute')
     RETURNING b.id, b.booking_code, b.pickup_address,
               to_char(b.pickup_date, 'DD Mon') AS pickup_day, to_char(b.pickup_time, 'HH24:MI') AS pickup_hm,
               d.full_name AS driver_name, d.phone AS driver_phone`,
    [minutes, WAKEUP_ANSWER_MINUTES]
  );
  for (const b of claimed.rows) {
    await recordBookingEvent({
      bookingId: Number(b.id),
      eventType: 'WAKEUP_ALERTED',
      actorType: 'SYSTEM',
      actorLabel: 'Wake-up Cron',
      summary: `Driver ${b.driver_name} did not confirm wake-up check — admins alerted`,
      metadata: { driverName: b.driver_name, driverPhone: b.driver_phone },
    });
    await notifyAdmins(
      `⏰ Driver ${b.driver_name} (${b.driver_phone}) has NOT confirmed trip #${b.booking_code}: pickup ${b.pickup_day} at ${b.pickup_hm}, ${b.pickup_address}. Call the driver, or reassign the ride from the CRM.`
    );
  }
  return claimed.rows.length;
}

/**
 * 3A. Suspend drivers whose license or vehicle documents have expired.
 * Safe to run often: a driver is only picked up while APPROVED_ACTIVE, and is suspended here.
 */
export async function runExpiredDocumentSuspensions(): Promise<number> {
  const expiredSql = `
    SELECT DISTINCT d.id, d.full_name, d.phone, d.whatsapp_phone, v.registration_no
    FROM crm_drivers d
    JOIN crm_driver_vehicles v ON v.driver_id = d.id AND v.removed_at IS NULL
    WHERE d.onboarding_status = 'APPROVED_ACTIVE'
      AND (
        (d.license_expiry IS NOT NULL AND d.license_expiry < CURRENT_DATE)
        OR (v.insurance_expiry IS NOT NULL AND v.insurance_expiry < CURRENT_DATE)
        OR (v.fitness_expiry IS NOT NULL AND v.fitness_expiry < CURRENT_DATE)
        OR (v.permit_expiry IS NOT NULL AND v.permit_expiry < CURRENT_DATE)
      );
  `;

  const expiredRes = await query(expiredSql);
  let suspendedCount = 0;

  for (const d of expiredRes.rows) {
    await query(
      `UPDATE crm_drivers 
       SET onboarding_status = 'SUSPENDED_DOC_EXPIRED', is_available = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [d.id]
    );
    await syncDriverPlanSuspension(Number(d.id), false);

    const targetPhone = d.whatsapp_phone || d.phone;
    if (targetPhone) {
      const notice = `Account suspended: one or more vehicle/license documents for vehicle ${d.registration_no || ''} have expired. To resume receiving rides, submit renewed documents to the BiharCabs office.`;
      await notify(targetPhone, 'driver_account_notice', { params: [notice], freeform: () => sendWhatsAppText(targetPhone, `⚠️ ${notice}`) });
    }
    suspendedCount++;
  }

  return suspendedCount;
}

/**
 * 3B. Remind drivers whose documents expire within 15 days.
 * Nothing records who was reminded, so every run messages every such driver again.
 * Run it only from the daily schedule (/api/dispatch/cron/daily), never the frequent one.
 */
export async function runDocumentExpiryWarnings(): Promise<number> {
  const warningSql = `
    SELECT DISTINCT d.id, d.full_name, d.phone, d.whatsapp_phone, v.registration_no,
           LEAST(d.license_expiry, v.insurance_expiry, v.fitness_expiry, v.permit_expiry) AS earliest_expiry
    FROM crm_drivers d
    JOIN crm_driver_vehicles v ON v.driver_id = d.id AND v.removed_at IS NULL
    WHERE d.onboarding_status = 'APPROVED_ACTIVE'
      AND LEAST(d.license_expiry, v.insurance_expiry, v.fitness_expiry, v.permit_expiry) BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '15 days');
  `;

  const warnRes = await query(warningSql);
  let warningCount = 0;

  for (const d of warnRes.rows) {
    const targetPhone = d.whatsapp_phone || d.phone;
    if (targetPhone) {
      const notice = `Your cab commercial documents for ${d.registration_no || 'your vehicle'} expire on ${new Date(d.earliest_expiry).toLocaleDateString('en-IN')}. Renew and upload them to avoid automatic suspension from rides.`;
      await notify(targetPhone, 'driver_account_notice', { params: [notice], freeform: () => sendWhatsAppText(targetPhone, `⚠️ Document Renewal Reminder: ${notice}`) });
      warningCount++;
    }
  }

  return warningCount;
}

/**
 * 4. Unpaid Dues Guardrail with Soft Degradation (Digital-Only Mode) & 1-Tap UPI Micro-Recharge
 */
export async function runUnpaidDuesGuardrails(): Promise<number> {
  const revPolicy = await getRevenueProtectionPolicy();
  const company = await getCompanyBillingInfo();

  const duesSql = `
    SELECT 
      id, full_name, phone, whatsapp_phone, wallet_balance, rating, total_trips_completed,
      CASE 
        WHEN rating >= ($1::numeric) AND total_trips_completed >= ($2::integer) THEN ($3::numeric)
        WHEN rating >= ($4::numeric) THEN ($5::numeric)
        ELSE ($6::numeric)
      END AS dynamic_leeway
    FROM crm_drivers
    WHERE onboarding_status = 'APPROVED_ACTIVE'
      AND wallet_balance < -(
        CASE 
          WHEN rating >= ($1::numeric) AND total_trips_completed >= ($2::integer) THEN ($3::numeric)
          WHEN rating >= ($4::numeric) THEN ($5::numeric)
          ELSE ($6::numeric)
        END
      );
  `;

  const res = await query(duesSql, [
    revPolicy.elite_min_rating,
    revPolicy.elite_min_trips,
    revPolicy.dynamic_credit_limits.elite,
    revPolicy.standard_min_rating,
    revPolicy.dynamic_credit_limits.standard,
    revPolicy.dynamic_credit_limits.probation_or_new,
  ]);

  let restrictedCount = 0;

  for (const d of res.rows) {
    const newStatus = revPolicy.enable_digital_only_soft_mode
      ? 'RESTRICTED_DIGITAL_ONLY'
      : 'SUSPENDED_UNPAID_DUES';
    const isAvail = revPolicy.enable_digital_only_soft_mode;

    await query(
      `UPDATE crm_drivers 
       SET onboarding_status = $1,
           is_available = $2,
           last_dues_reminder_sent_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [newStatus, isAvail, d.id]
    );
    await syncDriverPlanSuspension(Number(d.id), false);

    const targetPhone = d.whatsapp_phone || d.phone;
    const unpaidAmount = Math.abs(Number(d.wallet_balance)).toFixed(2);
    const upiLink = `upi://pay?pa=${revPolicy.company_upi_vpa}&pn=${encodeURIComponent(revPolicy.company_upi_name)}&am=${unpaidAmount}&cu=INR&tn=Dues-Driver-${d.id}`;

    if (targetPhone) {
      const limit = `₹${Number(d.dynamic_leeway).toFixed(0)}`;
      const effect = revPolicy.enable_digital_only_soft_mode
        ? 'Until then you get advance-paid rides only, which clear your dues automatically.'
        : 'Your account is paused until the dues are cleared.';
      await notify(targetPhone, 'driver_dues_reminder', {
        ref: Number(d.id),
        params: [`₹${unpaidAmount}`, limit, effect],
        freeform: () => revPolicy.enable_digital_only_soft_mode
          ? sendWhatsAppButtons(
          targetPhone,
          `⚠️ Account Placed in Digital-Only Mode (Dues: ₹${unpaidAmount}):\nNamaste ${d.full_name}, your balance exceeds your credit limit of ₹${Number(d.dynamic_leeway).toFixed(0)}.\n\nTo ensure you keep earning, you will receive advance-paid & corporate rides to automatically clear your dues.\n\nTo instantly restore full access to high-value cash & outstation rides, tap below to clear dues via UPI:`,
          [
            { id: `pay_dues_${d.id}`, title: `💳 Pay ₹${unpaidAmount} via UPI` },
          ],
          'BiharCabs Dues Settlement'
        )
          : sendWhatsAppText(
          targetPhone,
          `⚠️ Account Paused (Unpaid Dues: ₹${unpaidAmount}):\nYour balance exceeds the limit of ₹${Number(d.dynamic_leeway).toFixed(0)}.\nPlease clear your balance via UPI: ${revPolicy.company_upi_vpa}\nDispatch support: ${company.phone}`
        ),
      });
      restrictedCount++;
    }
  }

  return restrictedCount;
}

/**
 * Return trips: rides whose returning-driver priority window ended go to regular drivers,
 * and driver return statuses past their time are closed.
 */
export async function runReturnTripTasks(): Promise<{ released: number; expired: number }> {
  const released = await releaseExpiredReturnWindows();
  for (const r of released) {
    await notifyOfferedDrivers(r.bookingId, r.result);
  }
  const expired = await expireDriverReturns();
  return { released: released.length, expired };
}

/**
 * Frequent jobs (every few minutes, POST /api/dispatch/cron). Each one changes a status or records
 * a sent time, so repeating a run does not repeat its messages.
 */
export async function executeFrequentCronTasks(): Promise<FrequentCronResult> {
  // Runs before SLA escalation so a ride leaves its priority window and gets a second wave before escalating.
  const returnTrips = await runReturnTripTasks();
  const ridesRebroadcasted = await runUnassignedRideRebroadcast().catch((err) => {
    console.error('[Cron] Unassigned ride rebroadcast failed:', err?.message);
    return 0;
  });
  const breached = await runSlaEscalation();
  const wakeups = await runDriverWakeupChecks();
  const unconfirmed = await runUnconfirmedWakeupAlerts();
  const suspended = await runExpiredDocumentSuspensions();
  const dues = await runUnpaidDuesGuardrails();
  // Payment links whose Razorpay expiry webhook never arrived; a Razorpay problem must not stop the other jobs.
  const links = await reconcileStalePaymentLinks().catch((err) => {
    console.error('[Cron] Payment link reconciliation failed:', err?.message);
    return { checked: 0, closed: 0, paidAlerts: 0 };
  });
  // GST documents to customers (per CA); a WhatsApp or Meta problem must not stop the other jobs.
  const gstDocs = await sendPendingGstDocuments().catch((err) => {
    console.error('[Cron] GST document delivery failed:', err?.message);
    return { sent: 0, failed: 0, retrying: 0, waitingForGstin: false };
  });
  // Last, so it reports messages that failed in the jobs above.
  const failedMessages = await runFailedMessageDigest().catch((err) => {
    console.error('[Cron] Failed-message summary failed:', err?.message);
    return 0;
  });

  return {
    ridesRebroadcasted,
    slaBreachesEscalated: breached.length,
    wakeupChecksSent: wakeups,
    unconfirmedWakeupAlerts: unconfirmed,
    documentsExpiredSuspended: suspended,
    unpaidDuesSuspended: dues,
    returnWindowsReleased: returnTrips.released,
    driverReturnsExpired: returnTrips.expired,
    paymentLinksClosed: links.closed,
    paymentLinkPaidAlerts: links.paidAlerts,
    failedMessagesReported: failedMessages,
    gstDocumentsSent: gstDocs.sent,
    gstDocumentsFailed: gstDocs.failed,
  };
}

/** Daily jobs (once a day, POST /api/dispatch/cron/daily). */
export async function executeDailyCronTasks(): Promise<DailyCronResult> {
  const fuelSync = await syncFuelPricesFromApi({ force: false }).catch((err) => {
    console.error('[Cron] Daily fuel price sync failed:', err?.message);
    return { synced: false };
  });
  return {
    documentsExpiringWarned: await runDocumentExpiryWarnings(),
    loginAttemptsPurged: await purgeOldLoginAttempts(),
    cancellationDocumentsIssued: 0,
    fuelPricesSynced: Boolean(fuelSync.synced),
  };
}

