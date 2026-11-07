import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { sendWhatsAppText } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const phone = searchParams.get('phone');

    if (phone) {
      const cleanPhone = phone.replace(/\D/g, '');
      const messagesRes = await query(
        `SELECT id, direction, phone, message_type, payload, status, error_message, created_at
         FROM crm_whatsapp_logs
         WHERE phone = $1
         ORDER BY created_at ASC
         LIMIT 100`,
        [cleanPhone]
      );

      const convRes = await query(
        `SELECT * FROM crm_whatsapp_conversations WHERE phone = $1`,
        [cleanPhone]
      );

      return NextResponse.json({
        success: true,
        conversation: convRes.rows[0] || null,
        messages: messagesRes.rows,
      });
    }

    // List recent conversation threads
    const threadsRes = await query(
      `SELECT 
         c.phone,
         c.state,
         c.role,
         c.context_data,
         c.last_message_at,
         cust.full_name AS customer_name,
         d.full_name AS driver_name,
         (
           SELECT payload->>'text' 
           FROM crm_whatsapp_logs 
           WHERE phone = c.phone 
           ORDER BY created_at DESC 
           LIMIT 1
         ) AS last_message_preview
       FROM crm_whatsapp_conversations c
       LEFT JOIN crm_customers cust ON cust.phone = c.phone
       LEFT JOIN crm_drivers d ON d.phone = c.phone OR d.whatsapp_phone = c.phone
       ORDER BY c.last_message_at DESC
       LIMIT 50`
    );

    return NextResponse.json({
      success: true,
      threads: threadsRes.rows,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { phone, text } = await req.json();

    if (!phone || !text) {
      return NextResponse.json(
        { success: false, error: 'phone and text are required' },
        { status: 400 }
      );
    }

    const result = await sendWhatsAppText(phone, text);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

