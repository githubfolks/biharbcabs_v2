import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';
import {
  DigestSlot,
  buildFounderDigestSummary,
  formatFounderDigestMessage,
  getFounderDigestConfig,
  resolveDigestRecipients,
  sendFounderDigest,
} from '@/lib/founder-digest';

export const dynamic = 'force-dynamic';

function parseSlot(raw: unknown): DigestSlot {
  return String(raw || '').toUpperCase() === 'EVENING' ? 'EVENING' : 'MORNING';
}

/** Preview the Morning (8 AM) or Evening (8 PM) Founder WhatsApp Digest without sending. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'settings.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const slot = parseSlot(req.nextUrl.searchParams.get('slot'));
    const [config, summary] = await Promise.all([
      getFounderDigestConfig(),
      buildFounderDigestSummary(slot),
    ]);
    const recipients = await resolveDigestRecipients(config);
    const message = formatFounderDigestMessage(summary);

    return NextResponse.json({
      success: true,
      config,
      recipients,
      summary,
      message,
    });
  } catch (err: any) {
    return handleRouteError(err, 'API finance/founder-digest');
  }
}

/** Trigger an immediate Morning or Evening Founder WhatsApp Digest send. */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'settings.change');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json().catch(() => ({}));
    const slot = parseSlot(body?.slot);
    const result = await sendFounderDigest(slot);

    await recordAuditLog({
      actor: auth,
      action: 'FOUNDER_DIGEST_SENT',
      entityType: 'SETTINGS',
      entityId: slot,
      summary: `Manually triggered ${slot} Founder WhatsApp Digest (${result.sent}/${result.recipients.length} sent)`,
      afterData: { slot, sent: result.sent, recipientCount: result.recipients.length },
      req,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    return handleRouteError(err, 'API finance/founder-digest');
  }
}
