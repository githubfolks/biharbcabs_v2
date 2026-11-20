/**
 * WhatsApp messages to a driver when staff change their account (owner decisions):
 *   - sent for approval or reactivation, manual suspension, and offers paused or resumed; not for offboarding;
 *   - fixed wording per event: the reason staff typed is for internal records and is never sent.
 * Sent after the change is saved. A message that fails never undoes the change: it is recorded under
 * Failed messages (crm_notification_failures) by notify(), and the caller is told it was not delivered.
 */
import { query } from './db';
import { sendWhatsAppText } from './whatsapp';
import { notify } from './wa-notify';

export type DriverNoticeEvent = 'APPROVED' | 'REACTIVATED' | 'SUSPENDED' | 'OFFERS_PAUSED' | 'OFFERS_RESUMED';

export interface DriverNoticeResult {
  sent: boolean;
  error?: string;
}

const CONTACT = 'Please contact the BiharCabs operations team if you have questions.';

/** The message for an event. Pure, so it can be tested; never includes a staff reason. */
export function driverNoticeText(event: DriverNoticeEvent): string {
  switch (event) {
    case 'APPROVED':
      return 'Your documents are verified and your BiharCabs driver account is approved. You will now receive ride offers on WhatsApp.';
    case 'REACTIVATED':
      return 'Your BiharCabs driver account is active again. You will now receive ride offers on WhatsApp.';
    case 'SUSPENDED':
      return `Your BiharCabs driver account has been suspended, so you will not receive ride offers. ${CONTACT}`;
    case 'OFFERS_PAUSED':
      return `Ride offers to you are paused for now. Your account is otherwise unchanged. ${CONTACT}`;
    case 'OFFERS_RESUMED':
      return 'Ride offers to you have resumed. You will now receive ride offers on WhatsApp.';
  }
}

/** The event for a status change, or null when the driver is not messaged (offboarding). */
export function statusChangeEvent(action: 'ACTIVATE' | 'SUSPEND' | 'OFFBOARD', fromStatus: string): DriverNoticeEvent | null {
  if (action === 'ACTIVATE') return fromStatus === 'PENDING_DOCS' ? 'APPROVED' : 'REACTIVATED';
  if (action === 'SUSPEND') return 'SUSPENDED';
  return null;
}

/** Sends the notice. Never throws. */
export async function notifyDriver(driverId: number, event: DriverNoticeEvent): Promise<DriverNoticeResult> {
  try {
    const r = await query(`SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1`, [driverId]);
    const phone = [r.rows[0]?.whatsapp_phone, r.rows[0]?.phone].map((p) => String(p || '').replace(/\D/g, '')).find(Boolean);
    if (!phone) return { sent: false, error: 'Driver has no phone number' };
    const text = driverNoticeText(event);
    const result = await notify(phone, 'driver_account_notice', {
      params: [text],
      freeform: () => sendWhatsAppText(phone, `BiharCabs account update: ${text}`),
    });
    return result.success ? { sent: true } : { sent: false, error: result.error || 'Not delivered' };
  } catch (err: any) {
    console.error(`[Driver Notice] ${event} to driver #${driverId} failed:`, err?.message);
    return { sent: false, error: 'Not delivered' };
  }
}
