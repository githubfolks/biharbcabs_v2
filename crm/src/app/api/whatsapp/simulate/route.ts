import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { query } from '@/lib/db';
import { logWhatsAppMessage } from '@/lib/whatsapp';
import { processIncomingWhatsAppMessage } from '@/lib/whatsapp-bot';

export const dynamic = 'force-dynamic';

/**
 * Admin-authenticated WhatsApp User-End Simulator API.
 * Feeds simulated inbound user/driver messages & interactive button/list replies directly into
 * the real `processIncomingWhatsAppMessage()` state machine so bookings, dispatch offers,
 * Start OTP, wake-up checks, trip completion, billing ledger, and ride timeline execute
 * through the exact production backend logic.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'inbox.use');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const rawPhone = String(body?.phone || '').replace(/\D/g, '');
    if (rawPhone.length < 10) {
      return NextResponse.json(
        { success: false, error: 'Please provide a valid phone number (with country code, e.g. 919876543210).' },
        { status: 400 }
      );
    }

    const text = typeof body?.text === 'string' ? body.text.trim() : undefined;
    const buttonId = typeof body?.buttonId === 'string' ? body.buttonId.trim() : undefined;
    const buttonText = typeof body?.buttonText === 'string' ? body.buttonText.trim() : undefined;
    const customerName =
      typeof body?.customerName === 'string' && body.customerName.trim()
        ? body.customerName.trim()
        : undefined;

    if (!text && !buttonId) {
      return NextResponse.json(
        { success: false, error: 'Provide either text or buttonId to simulate an inbound message.' },
        { status: 400 }
      );
    }

    const messageType = buttonId ? 'interactive' : 'text';
    const simulatedPayload = buttonId
      ? {
          simulated: true,
          simulated_by_admin_id: auth.id,
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: buttonId, title: buttonText || buttonId },
          },
          text: buttonText || buttonId,
        }
      : {
          simulated: true,
          simulated_by_admin_id: auth.id,
          type: 'text',
          text: { body: text },
        };

    await logWhatsAppMessage('INBOUND', rawPhone, messageType, simulatedPayload, 'RECEIVED');

    await processIncomingWhatsAppMessage({
      fromPhone: rawPhone,
      customerName,
      text: text || buttonText,
      buttonId,
      buttonText,
    });

    const [messagesRes, convRes] = await Promise.all([
      query(
        `SELECT id, direction, phone, message_type, payload, status, error_message, created_at
         FROM crm_whatsapp_logs
         WHERE phone = $1
         ORDER BY created_at ASC, id ASC
         LIMIT 150`,
        [rawPhone]
      ),
      query(`SELECT * FROM crm_whatsapp_conversations WHERE phone = $1`, [rawPhone]),
    ]);

    return NextResponse.json({
      success: true,
      phone: rawPhone,
      conversation: convRes.rows[0] || null,
      messages: messagesRes.rows,
    });
  } catch (err: any) {
    console.error('[WhatsApp Simulator] Error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
