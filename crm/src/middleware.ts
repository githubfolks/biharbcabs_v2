import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE_NAME = 'biharcabs_crm_session';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow static files, Next internals, auth endpoints, public website APIs, and webhooks
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/public/') ||
    pathname.startsWith('/api/whatsapp/webhook') ||
    pathname === '/api/payments/razorpay/webhook' ||
    pathname.startsWith('/api/dispatch/cron') ||
    pathname === '/login' ||
    pathname.startsWith('/trip/') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;

  // Only presence is checked here: this runs without database access. Every admin API route also
  // validates the session itself with requireAdmin() from src/lib/auth.ts.
  if (!sessionToken) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Not signed in' }, { status: 401 });
    }
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

