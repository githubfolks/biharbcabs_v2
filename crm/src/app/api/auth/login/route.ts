import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { verifyPassword, hashPassword, createAdminSession, SESSION_COOKIE_NAME } from '@/lib/auth';
import { getLockStatus, getLoginSecurityPolicy, recordLoginAttempt, trustedClientIp } from '@/lib/login-security';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

// Checked against when the email is unknown, so a reply takes as long whether or not the account exists.
const DUMMY = hashPassword('not-a-real-password');

type Outcome =
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'invalid' }
  | { kind: 'inactive' }
  | { kind: 'ok'; user: { id: number; email: string; full_name: string; role: string } };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const email = body?.email;
    const password = body?.password;
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return NextResponse.json({ success: false, error: 'Email and password are required' }, { status: 400 });
    }
    if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return NextResponse.json({ success: false, error: 'Invalid email or password' }, { status: 401 });
    }

    const cleanEmail = email.trim().toLowerCase();
    const ip = trustedClientIp(req);
    const policy = await getLoginSecurityPolicy();

    // One attempt per email at a time, so parallel guesses cannot slip past the limit.
    const outcome = await withTransaction<Outcome>(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`crm-login:${cleanEmail}`]);

      const lock = await getLockStatus(client, cleanEmail, ip, policy);
      if (lock.locked) {
        await recordLoginAttempt(client, cleanEmail, ip, 'LOCKED');
        return { kind: 'locked', retryAfterSeconds: lock.retryAfterSeconds };
      }

      const res = await client.query(
        `SELECT id, email, password_hash, salt, full_name, role, is_active
         FROM crm_admin_users WHERE LOWER(email) = $1 LIMIT 1`,
        [cleanEmail]
      );
      const user = res.rows[0];
      const valid = user
        ? verifyPassword(password, user.password_hash, user.salt)
        : (verifyPassword(password, DUMMY.hash, DUMMY.salt), false);

      if (!valid) {
        await recordLoginAttempt(client, cleanEmail, ip, 'FAILURE');
        return { kind: 'invalid' };
      }
      await recordLoginAttempt(client, cleanEmail, ip, 'SUCCESS');
      // Only someone with the right password learns that an account is deactivated.
      if (!user.is_active) return { kind: 'inactive' };
      return { kind: 'ok', user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } };
    });

    if (outcome.kind === 'locked') {
      const minutes = Math.ceil(outcome.retryAfterSeconds / 60);
      console.warn(`[Auth] Sign-in refused for ${cleanEmail}${ip ? ` from ${ip}` : ''}: too many failed attempts`);
      await recordAuditLog({
        actorEmail: cleanEmail,
        action: 'AUTH_LOGIN_LOCKED',
        entityType: 'AUTH',
        summary: `Login locked for ${cleanEmail} (too many failed attempts)`,
        afterData: { retryAfterSeconds: outcome.retryAfterSeconds },
        req,
      });
      return NextResponse.json(
        { success: false, error: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
        { status: 429, headers: { 'Retry-After': String(outcome.retryAfterSeconds) } }
      );
    }
    if (outcome.kind === 'invalid') {
      await recordAuditLog({
        actorEmail: cleanEmail,
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'AUTH',
        summary: `Failed login attempt for ${cleanEmail}`,
        req,
      });
      return NextResponse.json({ success: false, error: 'Invalid email or password' }, { status: 401 });
    }
    if (outcome.kind === 'inactive') {
      await recordAuditLog({
        actorEmail: cleanEmail,
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'AUTH',
        summary: `Sign-in blocked for deactivated account ${cleanEmail}`,
        req,
      });
      return NextResponse.json({ success: false, error: 'This admin account has been deactivated' }, { status: 403 });
    }

    const userAgent = req.headers.get('user-agent') || undefined;
    const { token, expiresAt } = await createAdminSession(outcome.user.id, userAgent, ip || undefined);
    await recordAuditLog({
      actor: outcome.user,
      action: 'AUTH_LOGIN',
      entityType: 'AUTH',
      entityId: outcome.user.id,
      summary: `Admin ${outcome.user.email} (${outcome.user.role}) signed in`,
      req,
    });

    const response = NextResponse.json({ success: true, user: outcome.user });
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
    return response;
  } catch (err: any) {
    console.error('[Auth] Sign-in failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Sign-in failed. Please try again.' }, { status: 500 });
  }
}
