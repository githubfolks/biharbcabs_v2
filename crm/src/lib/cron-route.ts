import { NextRequest, NextResponse } from 'next/server';
import { checkCronAuthorization, getCronSecret } from './cron-auth';
import { notifyAdmins } from './wa-notify';

/**
 * Shared handler for the scheduled-job routes. The scheduler (n8n) must send
 * "Authorization: Bearer <CRON_SECRET>". Until CRON_SECRET is set, every call is refused.
 */
export async function handleCronRequest(
  req: NextRequest,
  label: string,
  run: () => Promise<Record<string, any>>
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
    const jobErrors: Array<{ job: string; error: string }> = Array.isArray(cronResults?.errors)
      ? cronResults.errors
      : [];

    if (jobErrors.length > 0) {
      const summary = jobErrors.map((e) => `${e.job}: ${e.error}`).join('; ');
      console.error(`[Cron ${label}] Completed with ${jobErrors.length} job error(s): ${summary}`);
      await notifyAdmins(
        `⚠️ Cron (${label}) had ${jobErrors.length} job error(s): ${summary.slice(0, 300)}`
      ).catch((err) => console.error(`[Cron ${label}] Admin error alert failed:`, err));
      return NextResponse.json(
        {
          success: false,
          timestamp: new Date().toISOString(),
          cronResults,
          errors: jobErrors,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, timestamp: new Date().toISOString(), cronResults });
  } catch (err: any) {
    console.error(`[Cron ${label}] Failed:`, err);
    await notifyAdmins(
      `🚨 Cron (${label}) crashed: ${String(err?.message || 'Unexpected error').slice(0, 250)}`
    ).catch((admErr) => console.error(`[Cron ${label}] Admin crash alert failed:`, admErr));
    return NextResponse.json({ success: false, error: 'Cron execution failed' }, { status: 500 });
  }
}
