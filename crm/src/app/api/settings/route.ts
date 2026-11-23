import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getAllSettings, updateSetting } from '@/lib/settings';
import { checkReturnTripPolicy } from '@/lib/return-trip-pricing';
import { keepUnchangedSecrets, maskSettings } from '@/lib/settings-secrets';
import { resetFuelSyncMemoryCache } from '@/lib/fuel-price-sync';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'settings.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const settings = await getAllSettings(true);
    return NextResponse.json({ success: true, settings: maskSettings(settings) });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'settings.change');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const { key, value, description } = body;

    if (!key || value === undefined) {
      return NextResponse.json(
        { success: false, error: 'Missing key or value' },
        { status: 400 }
      );
    }

    // A masked or omitted secret means "unchanged": keep the stored value.
    let toSave = keepUnchangedSecrets(key, value, (await getAllSettings(true))[key]);
    if (key === 'return_trip_policy') {
      // Money rules: save clean numbers, and refuse to switch the feature on with missing or invalid values.
      const check = checkReturnTripPolicy(value);
      if (check.policy.enabled && !check.active) {
        return NextResponse.json({ success: false, error: `Return trips not switched on: ${check.errors.join(' ')}` }, { status: 400 });
      }
      toSave = check.policy;
    }

    await updateSetting(key, toSave, description);
    if (key === 'fuel_price_api_config') {
      resetFuelSyncMemoryCache();
    }
    console.info(`[Settings] '${key}' changed by admin #${auth.id}`);
    const updated = await getAllSettings(true);

    return NextResponse.json({ success: true, settings: maskSettings(updated) });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
