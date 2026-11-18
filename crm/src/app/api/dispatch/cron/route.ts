import { NextRequest } from 'next/server';
import { executeFrequentCronTasks } from '@/lib/cron-service';
import { handleCronRequest } from '@/lib/cron-route';

export const dynamic = 'force-dynamic';

/** Frequent scheduled jobs. n8n calls this every 5 minutes. */
export async function POST(req: NextRequest) {
  return handleCronRequest(req, 'frequent', executeFrequentCronTasks);
}

export async function GET(req: NextRequest) {
  return POST(req);
}
