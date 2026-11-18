/**
 * Test helper: the latest trip OTP sent to a number, whether it went as the free-form message (inside
 * the 24-hour window) or as a template parameter (customer_driver_assigned / customer_trip_otp).
 */
import { query } from '../../lib/db';
import { TEMPLATE_DEFS } from '../../lib/wa-templates';

const OTP_PARAM: Record<string, number> = {
  bc_customer_driver_assigned: TEMPLATE_DEFS.customer_driver_assigned.params.indexOf('trip OTP'),
  bc_customer_trip_otp: TEMPLATE_DEFS.customer_trip_otp.params.indexOf('trip OTP'),
};

export async function latestOtpSentTo(phone: string): Promise<string | null> {
  const rows = (await query(
    `SELECT message_type, payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 20`,
    [phone]
  )).rows;
  for (const r of rows) {
    if (r.message_type === 'template') {
      const idx = OTP_PARAM[r.payload?.template?.name];
      const value = idx === undefined ? undefined : r.payload.template.components?.[0]?.parameters?.[idx]?.text;
      if (value && /^\d{4,8}$/.test(value)) return value;
    } else {
      const m = JSON.stringify(r.payload).match(/Trip OTP for booking #[\w-]+: \*(\d+)\*/);
      if (m) return m[1];
    }
  }
  return null;
}

/** Whether the latest message to a number was the given template, or free-form text containing `text`. */
export async function lastMessageIs(phone: string, templateName: string, text: string): Promise<boolean> {
  const r = (await query(
    `SELECT message_type, payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 ORDER BY id DESC LIMIT 1`,
    [phone]
  )).rows[0];
  if (!r) return false;
  return r.message_type === 'template' ? r.payload?.template?.name === templateName : JSON.stringify(r.payload).includes(text);
}
