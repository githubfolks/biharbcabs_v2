import { query } from './db';
import {
  getDriverWakeupCheckHours,
  getDriverMaxNegativeBalance,
  getAdminContacts,
  getCompanyBillingInfo,
  getRevenueProtectionPolicy,
} from './settings';
import { checkAndEscalateSlaBreaches, BookingDetails, releaseExpiredReturnWindows } from './dispatch-engine';
import { notifyOfferedDrivers } from './dispatch-notify';
import { expireDriverReturns } from './return-trips';
import { sendWhatsAppText, sendWhatsAppButtons } from './whatsapp';

export interface CronExecutionResult {
  slaBreachesEscalated: number;
  wakeupChecksSent: number;
  documentsExpiredSuspended: number;
  documentsExpiringWarned: number;
  unpaidDuesSuspended: number;
  returnWindowsReleased: number;
  driverReturnsExpired: number;
}

/**
 * 1. SLA Breach Escalation
 */
export async function runSlaEscalation(): Promise<BookingDetails[]> {
  const breachedBookings = await checkAndEscalateSlaBreaches();
  const adminContacts = await getAdminContacts();

  if (breachedBookings.length > 0 && adminContacts.length > 0) {
    for (const booking of breachedBookings) {
      const alertMsg = `⚠️ SLA Alert: Booking #${booking.booking_code} (${booking.origin_city} → ${booking.destination_city || 'Local'}) on ${booking.pickup_date} at ${booking.pickup_time} has NOT been confirmed by any driver! Tap to assign manually in CRM.`;
      for (const admin of adminContacts) {
        if (admin.phone) {
          await sendWhatsAppText(admin.phone, alertMsg);
        }
      }
    }
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
      AND (
        (b.pickup_date = CURRENT_DATE AND b.pickup_time <= (CURRENT_TIME + ($1 || ' hours')::interval))
        OR (b.pickup_date < CURRENT_DATE)
      )
    LIMIT 50;
  `;

  const res = await query(sql, [hoursBefore]);
  let sentCount = 0;

  for (const b of res.rows) {
    const targetPhone = b.whatsapp_phone || b.driver_phone;
    if (targetPhone) {
      await sendWhatsAppButtons(
        targetPhone,
        `⏰ Upcoming Pickup Reminder (#${b.booking_code}) in ${hoursBefore} hours at ${b.pickup_time}!\nPickup: ${b.pickup_address}\n\nPlease tap below to confirm you are awake, vehicle is ready, and you will arrive on time:`,
        [{ id: `wakeup_ready_${b.id}`, title: '⏰ I Am Ready & On Time' }],
        'BiharCabs Driver Wake-up Check'
      );

      await query(
        `UPDATE crm_bookings SET wakeup_sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [b.id]
      );
      sentCount++;
    }
  }

  return sentCount;
}

/**
 * 3. Driver & Vehicle Document Expiry Compliance Guardrails
 */
export async function runDocumentExpiryGuardrails(): Promise<{
  suspendedCount: number;
  warningCount: number;
}> {
  // A. Auto-suspend drivers with expired documents
  const expiredSql = `
    SELECT DISTINCT d.id, d.full_name, d.phone, d.whatsapp_phone, v.registration_no
    FROM crm_drivers d
    JOIN crm_driver_vehicles v ON v.driver_id = d.id
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

    const targetPhone = d.whatsapp_phone || d.phone;
    if (targetPhone) {
      await sendWhatsAppText(
        targetPhone,
        `⚠️ Account Suspended: One or more vehicle/license documents for vehicle ${d.registration_no || ''} have expired. To resume receiving ride broadcasts, please submit renewed documents to BiharCabs office.`
      );
    }
    suspendedCount++;
  }

  // B. Send warnings for documents expiring within 15 days
  const warningSql = `
    SELECT DISTINCT d.id, d.full_name, d.phone, d.whatsapp_phone, v.registration_no,
           LEAST(d.license_expiry, v.insurance_expiry, v.fitness_expiry, v.permit_expiry) AS earliest_expiry
    FROM crm_drivers d
    JOIN crm_driver_vehicles v ON v.driver_id = d.id
    WHERE d.onboarding_status = 'APPROVED_ACTIVE'
      AND LEAST(d.license_expiry, v.insurance_expiry, v.fitness_expiry, v.permit_expiry) BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '15 days');
  `;

  const warnRes = await query(warningSql);
  let warningCount = 0;

  for (const d of warnRes.rows) {
    const targetPhone = d.whatsapp_phone || d.phone;
    if (targetPhone) {
      await sendWhatsAppText(
        targetPhone,
        `⚠️ Document Renewal Reminder: Your cab commercial documents for ${d.registration_no || 'your vehicle'} expire soon (on ${new Date(d.earliest_expiry).toLocaleDateString('en-IN')}). Please renew and upload promptly to avoid automatic dispatch suspension.`
      );
      warningCount++;
    }
  }

  return { suspendedCount, warningCount };
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

    const targetPhone = d.whatsapp_phone || d.phone;
    const unpaidAmount = Math.abs(Number(d.wallet_balance)).toFixed(2);
    const upiLink = `upi://pay?pa=${revPolicy.company_upi_vpa}&pn=${encodeURIComponent(revPolicy.company_upi_name)}&am=${unpaidAmount}&cu=INR&tn=Dues-Driver-${d.id}`;

    if (targetPhone) {
      if (revPolicy.enable_digital_only_soft_mode) {
        await sendWhatsAppButtons(
          targetPhone,
          `⚠️ Account Placed in Digital-Only Mode (Dues: ₹${unpaidAmount}):\nNamaste ${d.full_name}, your balance exceeds your credit limit of ₹${Number(d.dynamic_leeway).toFixed(0)}.\n\nTo ensure you keep earning, you will receive advance-paid & corporate rides to automatically clear your dues.\n\nTo instantly restore full access to high-value cash & outstation rides, tap below to clear dues via UPI:`,
          [
            { id: `pay_dues_${d.id}`, title: `💳 Pay ₹${unpaidAmount} via UPI` },
          ],
          'BiharCabs Dues Settlement'
        );
      } else {
        await sendWhatsAppText(
          targetPhone,
          `⚠️ Account Paused (Unpaid Dues: ₹${unpaidAmount}):\nYour balance exceeds the limit of ₹${Number(d.dynamic_leeway).toFixed(0)}.\nPlease clear your balance via UPI: ${revPolicy.company_upi_vpa}\nDispatch support: ${company.phone}`
        );
      }
      restrictedCount++;
    }
  }

  return restrictedCount;
}

/**
 * Master Cron Runner executing all automated background checks.
 */
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

export async function executeAllCronTasks(): Promise<CronExecutionResult> {
  // Runs before SLA escalation so a ride leaves its priority window before it can be escalated.
  const returnTrips = await runReturnTripTasks();
  const breached = await runSlaEscalation();
  const wakeups = await runDriverWakeupChecks();
  const docs = await runDocumentExpiryGuardrails();
  const dues = await runUnpaidDuesGuardrails();

  return {
    slaBreachesEscalated: breached.length,
    wakeupChecksSent: wakeups,
    documentsExpiredSuspended: docs.suspendedCount,
    documentsExpiringWarned: docs.warningCount,
    unpaidDuesSuspended: dues,
    returnWindowsReleased: returnTrips.released,
    driverReturnsExpired: returnTrips.expired,
  };
}

