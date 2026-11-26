import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { DuesError, listDriversOwing, recordManualDuesPayment } from '@/lib/driver-dues';
import { notify } from '@/lib/wa-notify';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Drivers who owe BiharCabs money. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, drivers: await listDriversOwing() });
  } catch (err: any) {
    return handleRouteError(err, 'API finance/dues-payments');
  }
}

/** Record dues paid outside Razorpay: { driverId, amount, channel: UPI | BANK_TRANSFER | CASH, reference, notes? } */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'dues.record');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const driverId = Number(body?.driverId);
    if (!Number.isInteger(driverId) || driverId <= 0) {
      return NextResponse.json({ success: false, error: 'driverId is required' }, { status: 400 });
    }
    const result = await recordManualDuesPayment({
      driverId,
      amount: Number(body?.amount),
      channel: String(body?.channel || ''),
      reference: String(body?.reference || ''),
      notes: body?.notes,
      adminId: auth.id,
    });

    const d = (await query(`SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1`, [driverId])).rows[0];
    const phone = d?.whatsapp_phone || d?.phone;
    if (phone) {
      const balance = result.newWalletBalance;
      const text = `Dues payment of ₹${result.amount.toLocaleString('en-IN')} recorded. ${balance < 0 ? `Still owed: ₹${Math.abs(balance).toLocaleString('en-IN')}.` : 'You have no dues.'}${result.restored ? ' Your account is active again for all rides.' : ''}`;
      await notify(phone, 'driver_account_notice', { params: [text], freeform: () => sendWhatsAppText(phone, `✅ ${text}`) }).catch((err) =>
        console.error(`[Dues] Driver notification failed for driver #${driverId}:`, err?.message)
      );
    }
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    if (err instanceof DuesError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    return handleRouteError(err, 'API finance/dues-payments');
  }
}
