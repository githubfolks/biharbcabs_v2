import { query } from './db';
import { SendMessageResult, TemplateHeaderDocument, sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp';
import { getAdminContacts, getWhatsAppTemplates } from './settings';
import { TEMPLATE_DEFS, TemplateDef, TemplateKey } from './wa-templates';

/**
 * Business-initiated WhatsApp notifications.
 *
 * Per Meta's Cloud API docs, free-form (text and interactive) messages are delivered only inside the
 * 24-hour customer service window that opens when the recipient messages us; outside it only approved
 * template messages are delivered. notify() sends the rich free-form message while the window is open,
 * and the approved template otherwise. Templates are sent with body parameters only; a quick-reply tap
 * is mapped back to its booking through the template message id (context.id in the webhook), which is
 * recorded here at send time.
 */

const SERVICE_WINDOW_HOURS = 24;
const MAX_PARAM_LENGTH = 900;

const clean = (phone: string) => String(phone || '').replace(/\D/g, '');

/** True if this number has messaged us within the last 24 hours. */
export async function isServiceWindowOpen(phone: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM crm_whatsapp_logs
     WHERE phone = $1 AND direction = 'INBOUND' AND created_at > CURRENT_TIMESTAMP - make_interval(hours => $2)
     LIMIT 1`,
    [clean(phone), SERVICE_WINDOW_HOURS]
  );
  return res.rows.length > 0;
}

/** Template parameters must be single-line, non-empty text. */
export function templateParam(value: unknown): string {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, MAX_PARAM_LENGTH);
  return text || '-';
}

export interface NotifyOptions {
  /** Values for the template's {{n}} placeholders, in order. */
  params: unknown[];
  /** Booking or driver id that the template's buttons act on. */
  ref?: number;
  /** The rich message to send instead while the service window is open. */
  freeform?: () => Promise<SendMessageResult>;
  /** The file for a template with a DOCUMENT header (uploaded media). */
  headerDocument?: TemplateHeaderDocument;
  /**
   * Record a failure in crm_notification_failures (default). A caller that retries the send itself
   * passes false and records only its final failure (recordNotificationFailure), so one undelivered
   * message is reported once.
   */
  recordFailure?: boolean;
}

export interface NotifyResult extends SendMessageResult {
  channel: 'FREEFORM' | 'TEMPLATE';
}

/** The booking code in a message's params, where the template has one (for following up a failure). */
export function bookingCodeIn(key: TemplateKey, params: unknown[]): string | null {
  const i = (TEMPLATE_DEFS[key].params as readonly string[]).indexOf('booking code');
  if (i < 0) return null;
  const m = String(params[i] ?? '').match(/BC-[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

/**
 * Record a message that did not go out, for the admin summary and the dispatch board. Only what the
 * message was, who it was for and the booking code are kept, never the params: some carry the trip OTP.
 * Never throws, so recording a failure cannot change what the caller sees.
 */
export async function recordNotificationFailure(phone: string, key: TemplateKey, params: unknown[], channel: NotifyResult['channel'] | null, error: unknown) {
  try {
    await query(
      `INSERT INTO crm_notification_failures (template_key, channel, phone, booking_code, error) VALUES ($1, $2, $3, $4, $5)`,
      [key, channel, clean(phone).slice(0, 20) || '-', bookingCodeIn(key, params), String(error || 'Unknown error').slice(0, 500)]
    );
  } catch (err: any) {
    console.error(`[WhatsApp] Could not record failed ${key} to ${clean(phone)}:`, err?.message);
  }
}

/**
 * Send a business-initiated message. A failure (or an error raised while sending) is recorded in
 * crm_notification_failures; the caller still gets the same result or error as before.
 */
export async function notify(phone: string, key: TemplateKey, opts: NotifyOptions): Promise<NotifyResult> {
  const attempt: { channel: NotifyResult['channel'] | null } = { channel: null };
  let result: NotifyResult;
  try {
    result = await send(phone, key, opts, attempt);
  } catch (err: any) {
    if (opts.recordFailure !== false) await recordNotificationFailure(phone, key, opts.params, attempt.channel, err?.message || err);
    throw err;
  }
  if (!result.success && opts.recordFailure !== false) await recordNotificationFailure(phone, key, opts.params, result.channel, result.error);
  return result;
}

async function send(phone: string, key: TemplateKey, opts: NotifyOptions, attempt: { channel: NotifyResult['channel'] | null }): Promise<NotifyResult> {
  const def: TemplateDef = TEMPLATE_DEFS[key];
  if (opts.params.length !== def.params.length) {
    throw new Error(`notify(${key}): expected ${def.params.length} params, got ${opts.params.length}`);
  }
  if (def.buttons?.length && !opts.ref) throw new Error(`notify(${key}): a ref is required for its buttons`);
  if (def.header === 'DOCUMENT' && !opts.headerDocument) throw new Error(`notify(${key}): a document is required for its header`);

  if (opts.freeform && (await isServiceWindowOpen(phone))) {
    attempt.channel = 'FREEFORM';
    return { ...(await opts.freeform()), channel: 'FREEFORM' };
  }
  attempt.channel = 'TEMPLATE';

  const names = await getWhatsAppTemplates();
  const name = names[key];
  if (!name) {
    console.error(`[WhatsApp] No approved template configured for ${key}; message to ${clean(phone)} not sent.`);
    return { success: false, error: `No template configured for ${key}`, channel: 'TEMPLATE' };
  }
  const result = await sendWhatsAppTemplate(
    phone,
    name,
    names.language || 'en',
    opts.params.map((p) => ({ type: 'text' as const, text: templateParam(p) })),
    def.header === 'DOCUMENT' ? opts.headerDocument : undefined
  );
  if (result.success && result.messageId && def.buttons?.length) {
    await query(
      `INSERT INTO crm_wa_template_sends (wamid, phone, template_key, ref_id) VALUES ($1, $2, $3, $4) ON CONFLICT (wamid) DO NOTHING`,
      [result.messageId, clean(phone), key, opts.ref]
    );
  }
  if (!result.success) console.error(`[WhatsApp] Template ${name} to ${clean(phone)} failed: ${result.error}`);
  return { ...result, channel: 'TEMPLATE' };
}

/**
 * Turn a tap on a template quick-reply button into the bot action it stands for. Meta reports the tap
 * with the button label as its payload and the template message's id as context.id; the id identifies
 * the booking. Returns undefined for a tap that cannot be matched (it is then handled as plain text).
 */
export async function resolveTemplateButton(contextId: string | undefined, label: string | undefined, phone: string): Promise<string | undefined> {
  if (!contextId || !label) return undefined;
  const res = await query(
    `SELECT template_key, ref_id FROM crm_wa_template_sends WHERE wamid = $1 AND phone = $2`,
    [contextId, clean(phone)]
  );
  const row = res.rows[0];
  if (!row) return undefined;
  const def: TemplateDef | undefined = (TEMPLATE_DEFS as Record<string, TemplateDef>)[row.template_key];
  const button = def?.buttons?.find((b) => b.label.toLowerCase() === label.trim().toLowerCase());
  return button ? button.action.replace('{ref}', String(row.ref_id)) : undefined;
}

/** Alert every admin contact (template outside the window). Per-admin failures are isolated & logged. */
export async function notifyAdmins(message: string): Promise<number> {
  let contacts: Array<{ name?: string; phone?: string }> = [];
  try {
    contacts = (await getAdminContacts()).filter((a) => Boolean(a?.phone));
  } catch (err: any) {
    console.error('[WhatsApp] Failed to load admin contacts for alert:', err?.message || err);
    return 0;
  }

  if (contacts.length === 0) {
    console.warn('[WhatsApp] notifyAdmins called with no admin contacts configured; alert dropped.');
    return 0;
  }

  let sent = 0;
  for (const admin of contacts) {
    if (!admin.phone) continue;
    try {
      const r = await notify(admin.phone, 'admin_alert', {
        params: [message],
        freeform: () => sendWhatsAppText(admin.phone!, message),
      });
      if (r.success) sent++;
    } catch (err: any) {
      console.error(`[WhatsApp] Admin alert to ${clean(admin.phone)} failed:`, err?.message || err);
    }
  }
  return sent;
}
