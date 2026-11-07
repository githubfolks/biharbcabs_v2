import { NextRequest, NextResponse } from 'next/server';
import { executeAllCronTasks } from '@/lib/cron-service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const result = await executeAllCronTasks();
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      cronResults: result,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
