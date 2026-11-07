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
 * Internal helper to dispatch payload to Meta Graph API or simulate when offline.
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
    console.log(`[WhatsApp Sim] -> To: ${cleanPhone} | Type: ${messageType}`, JSON.stringify(messagePayload));
    await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'SENT');
    return { success: true, messageId: `local-sim-${Date.now()}` };
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
    });

    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'FAILED', errMsg);
      return { success: false, error: errMsg };
    }

    const messageId = data.messages?.[0]?.id;
    await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'SENT');
    return { success: true, messageId };
  } catch (err: any) {
    await logWhatsAppMessage('OUTBOUND', cleanPhone, messageType, fullPayload, 'FAILED', err.message);
    return { success: false, error: err.message };
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
export async function sendWhatsAppDocument(
  toPhone: string,
  documentUrl: string,
  fileName: string,
  caption?: string
): Promise<SendMessageResult> {
  return dispatchToMetaApi(toPhone, 'document', {
    document: {
      link: documentUrl,
      filename: fileName,
      caption: caption || undefined,
    },
  });
}

/**
 * Send an Official Meta WhatsApp Utility Template.
 */
export async function sendWhatsAppTemplate(
  toPhone: string,
  templateName: string,
  languageCode = 'en',
  parameters: Array<{ type: 'text' | 'currency' | 'date_time'; text?: string }> = []
): Promise<SendMessageResult> {
  const templatePayload: any = {
    name: templateName,
    language: { code: languageCode },
  };

  if (parameters.length > 0) {
    templatePayload.components = [
      {
        type: 'body',
        parameters,
      },
    ];
  }

  return dispatchToMetaApi(toPhone, 'template', { template: templatePayload });
}

/**
 * Parse an incoming Meta webhook event payload.
 */
export function parseIncomingWebhook(body: any): {
  messageId?: string;
  fromPhone?: string;
  customerName?: string;
  messageType?: string;
  text?: string;
  buttonId?: string;
  buttonText?: string;
  rawPayload: any;
} | null {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const message = value?.messages?.[0];
  const contact = value?.contacts?.[0];

  if (!message) {
    return null;
  }

  const fromPhone = message.from;
  const customerName = contact?.profile?.name || undefined;
  const messageType = message.type;

  let text: string | undefined;
  let buttonId: string | undefined;
  let buttonText: string | undefined;

  if (messageType === 'text') {
    text = message.text?.body;
  } else if (messageType === 'interactive') {
    const interactive = message.interactive;
    if (interactive.type === 'button_reply') {
      buttonId = interactive.button_reply?.id;
      buttonText = interactive.button_reply?.title;
    } else if (interactive.type === 'list_reply') {
      buttonId = interactive.list_reply?.id;
      buttonText = interactive.list_reply?.title;
    }
  } else if (messageType === 'button') {
    buttonId = message.button?.payload;
    buttonText = message.button?.text;
  }

  return {
    messageId: typeof message.id === 'string' ? message.id : undefined,
    fromPhone,
    customerName,
    messageType,
    text,
    buttonId,
    buttonText,
    rawPayload: message,
  };
}
