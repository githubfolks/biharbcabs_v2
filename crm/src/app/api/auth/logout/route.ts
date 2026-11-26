import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { revokeSession, validateSession, SESSION_COOKIE_NAME } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (token) {
      const admin = await validateSession(token).catch(() => null);
      await revokeSession(token);
      if (admin) {
        await recordAuditLog({
          actor: admin,
          action: 'AUTH_LOGOUT',
          entityType: 'AUTH',
          entityId: admin.id,
          summary: `Admin ${admin.email} signed out`,
          req,
        });
      }
    }

    const response = NextResponse.json({ success: true, message: 'Logged out successfully' });
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  } catch (err: any) {
    return handleRouteError(err, 'API auth/logout');
  }
}

