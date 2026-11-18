import { NextRequest } from 'next/server';
import { executeDailyCronTasks } from '@/lib/cron-service';
import { handleCronRequest } from '@/lib/cron-route';

export const dynamic = 'force-dynamic';

/** Daily scheduled jobs. n8n calls this once a day at 09:00 IST. */
export async function POST(req: NextRequest) {
  return handleCronRequest(req, 'daily', executeDailyCronTasks);
}
