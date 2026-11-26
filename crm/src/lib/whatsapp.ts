import { getMetaWhatsAppConfig, getWhatsAppTemplates } from './settings';
import { query } from './db';

export interface SendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Log all incoming or outgoing WhatsApp messages to the crm_whatsapp_logs audit table.
 */
export async function logWhatsAppMessage(
  direction: 'INBOUND' | 'OUTBOUND',
  phone: string,
  messageType: string,
  payload: any,
  status: 'RECEIVED' | 'SENT' | 'FAILED',
  errorMessage?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO crm_whatsapp_logs (direction, phone, message_type, payload, status, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [direction, phone, messageType, JSON.stringify(payload), status, errorMessage || null]
    );
  } catch (err) {
    console.error('[WhatsApp Logger Error]:', err);
  }
}

/**
 * Simulation is only allowed when explicitly opted-in via WHATSAPP_SIMULATION_MODE=true
 * and NEVER in production (NODE_ENV === 'production').
 */
export function isWhatsAppSimulationAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.WHATSAPP_SIMULATION_MODE === 'true';
}

/**
 * Internal helper to dispatch payload to Meta Graph API.
 * Fails explicitly when Meta credentials are not configured unless explicit non-prod simulation is enabled.
 */
async function dispatchToMetaApi(
  toPhone: string,
  messageType: string,
  messagePayload: any
): Promise<SendMessageResult> {
  const config = await getMetaWhatsAppConfig();
  const cleanPhone = toPhone.replace(/\D/g, '');

  const fullPayload = {
    messaging_product: 'whatsapp',
    to: cleanPhone,
    type: messageType,
    ...messagePayload,
  };

  if (!config.access_token || !config.phone_number_id) {
    if (isWhatsAppSimulationAllowed()) {
      console.log(`[WhatsApp Sim] -> To: ${cleanPhone} | Type: ${messageType}`, JSON.stringify(messagePayload));
      await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'SENT');
      return { success: true, messageId: `local-sim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
    }
    const errMsg = 'WhatsApp is not configured (missing access_token or phone_number_id)';
    console.error(`[WhatsApp] Refusing to simulate unconfigured send to ${cleanPhone}: ${errMsg}`);
    await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'FAILED', errMsg);
    return { success: false, error: errMsg };
  }

  const url = `https://graph.facebook.com/${config.api_version}/${config.phone_number_id}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fullPayload),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'FAILED', errMsg);
      return { success: false, error: errMsg };
    }

    const messageId = data.messages?.[0]?.id;
    await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'SENT');
    return { success: true, messageId };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'FAILED', errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Send an outbound text message via Meta WhatsApp Cloud API.
 */
export async function sendWhatsAppText(
  toPhone: string,
  text: string
): Promise<SendMessageResult> {
  return dispatchToMetaApi(toPhone, 'text', { text: { body: text } });
}

/**
 * Send an Interactive Button Message (max 3 buttons, e.g. Accept / Decline for Driver dispatch).
 */
export async function sendWhatsAppButtons(
  toPhone: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  headerText?: string,
  footerText?: string
): Promise<SendMessageResult> {
  const interactive: any = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.slice(0, 3).map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    },
  };

  if (headerText) {
    interactive.header = { type: 'text', text: headerText };
  }

  if (footerText) {
    interactive.footer = { text: footerText };
  }

  return dispatchToMetaApi(toPhone, 'interactive', { interactive });
}

/**
 * Send an Interactive List Message (for vehicle selection or route packages).
 */
export async function sendWhatsAppList(
  toPhone: string,
  bodyText: string,
  buttonText: string,
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>,
  headerText?: string,
  footerText?: string
): Promise<SendMessageResult> {
  const interactive: any = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonText,
      sections,
    },
  };

  if (headerText) {
    interactive.header = { type: 'text', text: headerText };
  }

  if (footerText) {
    interactive.footer = { text: footerText };
  }

  return dispatchToMetaApi(toPhone, 'interactive', { interactive });
}

/**
 * Send a Document Message (e.g. PDF Invoice).
 */
/**
 * Send a document uploaded with uploadWhatsAppMedia, by its media id (Meta recommends ids over links;
 * a link would need the document on a public URL). Delivered only inside the 24-hour service window.
 */
export async function sendWhatsAppDocument(
  toPhone: string,
  mediaId: string,
  fileName: string,
  caption?: string
): Promise<SendMessageResult> {
  return dispatchToMetaApi(toPhone, 'document', {
    document: {
      id: mediaId,
      filename: fileName,
      caption: caption || undefined,
    },
  });
}

/**
 * Upload a file to Meta for sending (POST /<PHONE_NUMBER_ID>/media, multipart: file, type,
 * messaging_product; returns { id }). Meta keeps the media, and its id is valid, for 30 days.
 * Without a configured token it is simulated, like sends. The file's contents are never logged.
 */
export async function uploadWhatsAppMedia(file: Buffer, fileName: string, mimeType: string): Promise<{ success: boolean; mediaId?: string; error?: string }> {
  const config = await getMetaWhatsAppConfig();
  if (!config.access_token || !config.phone_number_id) {
    if (isWhatsAppSimulationAllowed()) {
      console.log(`[WhatsApp Sim] -> Media upload ${fileName} (${file.length} bytes)`);
      return { success: true, mediaId: `local-sim-media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
    }
    const errMsg = 'WhatsApp is not configured (missing access_token or phone_number_id)';
    console.error(`[WhatsApp] Refusing to simulate unconfigured media upload ${fileName}: ${errMsg}`);
    return { success: false, error: errMsg };
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([new Uint8Array(file)], { type: mimeType }), fileName);
  try {
    const res = await fetch(`https://graph.facebook.com/${config.api_version}/${config.phone_number_id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.access_token}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.id !== 'string') {
      return { success: false, error: data?.error?.message || `Media upload failed: HTTP ${res.status}` };
    }
    return { success: true, mediaId: data.id };
  } catch (err: any) {
    return { success: false, error: `Media upload failed: ${err?.message || err}` };
  }
}

/**
 * Send an Official Meta WhatsApp Utility Template.
 */
/** A document for a template's DOCUMENT header, by uploaded media id. */
export interface TemplateHeaderDocument {
  mediaId: string;
  fileName: string;
}

export async function sendWhatsAppTemplate(
  toPhone: string,
  templateName: string,
  languageCode = 'en',
  parameters: Array<{ type: 'text' | 'currency' | 'date_time'; text?: string }> = [],
  headerDocument?: TemplateHeaderDocument
): Promise<SendMessageResult> {
  const templatePayload: any = {
    name: templateName,
    language: { code: languageCode },
  };

  const components: any[] = [];
  // UNVERIFIED against Meta's docs: they show image headers ({ type: 'image', image: { link } }) and
  // document messages ({ id, filename }); this document header follows both. Confirm on the first live send.
  if (headerDocument) {
    components.push({ type: 'header', parameters: [{ type: 'document', document: { id: headerDocument.mediaId, filename: headerDocument.fileName } }] });
  }
  if (parameters.length > 0) components.push({ type: 'body', parameters });
  if (components.length) templatePayload.components = components;

  return dispatchToMetaApi(toPhone, 'template', { template: templatePayload });
}

export interface ParsedIncomingWebhookMessage {
  messageId?: string;
  fromPhone?: string;
  customerName?: string;
  messageType?: string;
  text?: string;
  buttonId?: string;
  buttonText?: string;
  mediaId?: string;
  mediaMime?: string;
  /** For a tap on a template button: id of the template message that was tapped. */
  contextId?: string;
  rawPayload: any;
}

/**
 * Parse all incoming messages from a Meta webhook event payload (handles multi-entry/multi-message deliveries).
 */
export function parseIncomingWebhookMessages(body: any): ParsedIncomingWebhookMessage[] {
  const results: ParsedIncomingWebhookMessage[] = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];

      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;

        const fromPhone = message.from;
        const matchedContact =
          contacts.find((c: any) => c?.wa_id && c.wa_id === fromPhone) || contacts[0];
        const customerName = matchedContact?.profile?.name || undefined;
        const messageType = message.type;

        let text: string | undefined;
        let buttonId: string | undefined;
        let buttonText: string | undefined;
        let mediaId: string | undefined;
        let mediaMime: string | undefined;

        if (messageType === 'text') {
          text = message.text?.body;
        } else if (messageType === 'image') {
          mediaId = message.image?.id;
          mediaMime = message.image?.mime_type;
          text = message.image?.caption;
        } else if (messageType === 'document') {
          mediaId = message.document?.id;
          mediaMime = message.document?.mime_type;
          text = message.document?.caption;
        } else if (messageType === 'interactive') {
          const interactive = message.interactive;
          if (interactive?.type === 'button_reply') {
            buttonId = interactive.button_reply?.id;
            buttonText = interactive.button_reply?.title;
          } else if (interactive?.type === 'list_reply') {
            buttonId = interactive.list_reply?.id;
            buttonText = interactive.list_reply?.title;
          }
        } else if (messageType === 'button') {
          buttonId = message.button?.payload;
          buttonText = message.button?.text;
        }

        results.push({
          messageId: typeof message.id === 'string' ? message.id : undefined,
          fromPhone,
          customerName,
          messageType,
          text,
          buttonId,
          buttonText,
          mediaId,
          mediaMime,
          contextId: typeof message.context?.id === 'string' ? message.context.id : undefined,
          rawPayload: message,
        });
      }
    }
  }

  return results;
}

/**
 * Parse the first incoming Meta webhook event payload (kept for callers expecting a single message).
 */
export function parseIncomingWebhook(body: any): ParsedIncomingWebhookMessage | null {
  return parseIncomingWebhookMessages(body)[0] ?? null;
}
