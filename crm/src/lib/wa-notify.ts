import { query } from './db';
import { SendMessageResult, sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp';
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
}

export interface NotifyResult extends SendMessageResult {
  channel: 'FREEFORM' | 'TEMPLATE';
}

export async function notify(phone: string, key: TemplateKey, opts: NotifyOptions): Promise<NotifyResult> {
  const def: TemplateDef = TEMPLATE_DEFS[key];
  if (opts.params.length !== def.params.length) {
    throw new Error(`notify(${key}): expected ${def.params.length} params, got ${opts.params.length}`);
  }
  if (def.buttons?.length && !opts.ref) throw new Error(`notify(${key}): a ref is required for its buttons`);

  if (opts.freeform && (await isServiceWindowOpen(phone))) {
    return { ...(await opts.freeform()), channel: 'FREEFORM' };
  }

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
    opts.params.map((p) => ({ type: 'text' as const, text: templateParam(p) }))
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

/** Alert every admin contact (template outside the window). Failures are logged, never thrown. */
export async function notifyAdmins(message: string): Promise<number> {
  let sent = 0;
  try {
    for (const admin of await getAdminContacts()) {
      if (!admin.phone) continue;
      const r = await notify(admin.phone, 'admin_alert', { params: [message], freeform: () => sendWhatsAppText(admin.phone, message) });
      if (r.success) sent++;
    }
  } catch (err: any) {
    console.error('[WhatsApp] Admin alert failed:', err?.message);
  }
  return sent;
}
