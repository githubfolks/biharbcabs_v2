import { NextRequest, NextResponse } from 'next/server';
import { checkCronAuthorization, getCronSecret } from './cron-auth';

/**
 * Shared handler for the scheduled-job routes. The scheduler (n8n) must send
 * "Authorization: Bearer <CRON_SECRET>". Until CRON_SECRET is set, every call is refused.
 */
export async function handleCronRequest(
  req: NextRequest,
  label: string,
  run: () => Promise<object>
): Promise<NextResponse> {
  const auth = checkCronAuthorization(req.headers.get('authorization'), getCronSecret());
  if (auth === 'not_configured') {
    console.error(`[Cron ${label}] CRON_SECRET is not set; refusing to run scheduled jobs.`);
    return NextResponse.json({ success: false, error: 'cron_not_configured' }, { status: 503 });
  }
  if (auth === 'unauthorized') {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const cronResults = await run();
    return NextResponse.json({ success: true, timestamp: new Date().toISOString(), cronResults });
  } catch (err: any) {
    console.error(`[Cron ${label}] Failed:`, err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
