import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, updateSetting } from '@/lib/settings';
import { checkReturnTripPolicy } from '@/lib/return-trip-pricing';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const settings = await getAllSettings(true);
    return NextResponse.json({ success: true, settings });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { key, value, description } = body;

    if (!key || value === undefined) {
      return NextResponse.json(
        { success: false, error: 'Missing key or value' },
        { status: 400 }
      );
    }

    let toSave = value;
    if (key === 'return_trip_policy') {
      // Money rules: save clean numbers, and refuse to switch the feature on with missing or invalid values.
      const check = checkReturnTripPolicy(value);
      if (check.policy.enabled && !check.active) {
        return NextResponse.json({ success: false, error: `Return trips not switched on: ${check.errors.join(' ')}` }, { status: 400 });
      }
      toSave = check.policy;
    }

    await updateSetting(key, toSave, description);
    const updated = await getAllSettings(true);

    return NextResponse.json({ success: true, settings: updated });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
