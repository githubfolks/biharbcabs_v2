import { query } from './db';
import { notifyAdmins } from './wa-notify';
import { TEMPLATE_DEFS, TemplateKey } from './wa-templates';

/**
 * WhatsApp messages BiharCabs started that did not go out (recorded by notify() in wa-notify.ts).
 * Admins get one summary per frequent cron run; staff follow each one up by phone and mark it handled
 * on the dispatch board. There is no automatic resend: the message contents are not stored, because
 * some carry the customer's trip OTP.
 */

/** Lines listed in one admin summary; the rest are counted. */
const SUMMARY_LINES = 5;
const LIST_LIMIT = 100;

export class NotificationFailureError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export function templateTitle(key: string): string {
  return (TEMPLATE_DEFS as Record<string, { title: string }>)[key]?.title || key;
}

export interface NotificationFailure {
  id: number;
  templateKey: string;
  title: string;
  channel: string | null;
  phone: string;
  bookingCode: string | null;
  error: string;
  createdAt: string;
}

/** Open (not yet handled) failures, newest first, plus how many are open in total. */
export async function listOpenNotificationFailures(): Promise<{ failures: NotificationFailure[]; openCount: number }> {
  const [rows, count] = await Promise.all([
    query(
      `SELECT id, template_key, channel, phone, booking_code, error, created_at
       FROM crm_notification_failures WHERE resolved_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT $1`,
      [LIST_LIMIT]
    ),
    query(`SELECT COUNT(*)::int AS n FROM crm_notification_failures WHERE resolved_at IS NULL`),
  ]);
  return {
    openCount: count.rows[0].n,
    failures: rows.rows.map((r) => ({
      id: Number(r.id),
      templateKey: r.template_key,
      title: templateTitle(r.template_key),
      channel: r.channel,
      phone: r.phone,
      bookingCode: r.booking_code,
      error: r.error,
      createdAt: r.created_at,
    })),
  };
}

/** Mark a failure handled (staff followed it up). */
export async function resolveNotificationFailure(id: number, adminId: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new NotificationFailureError('Invalid id', 400);
  const r = await query(
    `UPDATE crm_notification_failures SET resolved_at = CURRENT_TIMESTAMP, resolved_by = $2
     WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
    [id, adminId]
  );
  if (r.rows.length) return;
  const exists = await query(`SELECT 1 FROM crm_notification_failures WHERE id = $1`, [id]);
  throw exists.rows.length
    ? new NotificationFailureError('Already marked handled', 409)
    : new NotificationFailureError('Not found', 404);
}

/**
 * One admin summary of the failures recorded since the last run. Every unalerted row is claimed, so
 * none is reported twice even if two runs overlap. Failed admin alerts are claimed but never reported
 * (the summary is itself an admin alert, so reporting them could loop), nor are failures already handled.
 * Returns how many failures the summary reported.
 */
export async function runFailedMessageDigest(): Promise<number> {
  const claimed = await query(
    `UPDATE crm_notification_failures SET alerted_at = CURRENT_TIMESTAMP
     WHERE alerted_at IS NULL
     RETURNING id, template_key, phone, booking_code, resolved_at`
  );
  const report = claimed.rows
    .filter((r) => r.template_key !== ('admin_alert' satisfies TemplateKey) && !r.resolved_at)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!report.length) return 0;

  const lines = report
    .slice(0, SUMMARY_LINES)
    .map((r) => `• ${templateTitle(r.template_key)} to ${r.phone}${r.booking_code ? `, #${r.booking_code}` : ''}`);
  const more = report.length - SUMMARY_LINES;
  await notifyAdmins(
    `⚠️ ${report.length} WhatsApp message${report.length === 1 ? '' : 's'} did not reach the recipient: ${lines.join(' ')}` +
      `${more > 0 ? ` and ${more} more.` : ''} Follow up by phone, then mark each handled under Failed messages on the dispatch board.`
  );
  return report.length;
}
