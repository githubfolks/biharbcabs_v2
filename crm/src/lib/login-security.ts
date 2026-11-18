import { NextRequest } from 'next/server';
import { PoolClient } from 'pg';
import { query } from './db';
import { getSetting } from './settings';

/**
 * Limits on failed admin sign-ins.
 *
 * - Per email: after max_failures_per_email failures inside the window (counting only failures since
 *   that email's last successful sign-in), further attempts are refused until the oldest counted
 *   failure leaves the window. Attempts for unknown emails are counted the same way, so a lockout
 *   never reveals whether an account exists.
 * - Per client IP: only when CLIENT_IP_HEADER names a header set by a trusted reverse proxy. Without
 *   it the IP is not known reliably (a caller can send any X-Forwarded-For), so no IP limit applies.
 */

export interface LoginSecurityPolicy {
  max_failures_per_email: number;
  max_failures_per_ip: number;
  window_minutes: number;
  retention_days: number;
}

/** Used when the setting is missing or invalid; the same values migration 13 seeds. */
const FALLBACK_POLICY: LoginSecurityPolicy = {
  max_failures_per_email: 5,
  max_failures_per_ip: 20,
  window_minutes: 15,
  retention_days: 90,
};

export async function getLoginSecurityPolicy(): Promise<LoginSecurityPolicy> {
  const raw = await getSetting<any>('login_security_policy', {});
  const policy: LoginSecurityPolicy = {
    max_failures_per_email: Number(raw.max_failures_per_email),
    max_failures_per_ip: Number(raw.max_failures_per_ip),
    window_minutes: Number(raw.window_minutes),
    retention_days: Number(raw.retention_days),
  };
  const valid = Object.values(policy).every((v) => Number.isInteger(v) && v >= 1);
  if (!valid) {
    console.error('[Auth] login_security_policy is missing or invalid; using the default limits.');
    return FALLBACK_POLICY;
  }
  return policy;
}

const IP_PATTERN = /^[0-9a-fA-F:.]{2,64}$/;

/**
 * The client IP from the header named in CLIENT_IP_HEADER (e.g. "x-real-ip" or "x-forwarded-for"
 * set by your reverse proxy). For a comma-separated list the last entry is used: the address the
 * trusted proxy itself saw. Returns null when not configured or not a plausible IP.
 */
export function trustedClientIp(req: NextRequest): string | null {
  const header = (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (!header) return null;
  const raw = req.headers.get(header);
  if (!raw) return null;
  const ip = raw.split(',').map((s) => s.trim()).filter(Boolean).pop() || '';
  return IP_PATTERN.test(ip) ? ip : null;
}

export interface LockStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

/** Whether this email (or trusted IP) is currently locked out. Call inside the per-email lock. */
export async function getLockStatus(
  client: PoolClient,
  email: string,
  ip: string | null,
  policy: LoginSecurityPolicy
): Promise<LockStatus> {
  const byEmail = await client.query(
    `SELECT COUNT(*)::int AS n, MIN(attempted_at) AS oldest
     FROM crm_login_attempts
     WHERE email = $1 AND outcome = 'FAILURE'
       AND attempted_at > CURRENT_TIMESTAMP - make_interval(mins => $2)
       AND attempted_at > COALESCE(
         (SELECT MAX(attempted_at) FROM crm_login_attempts WHERE email = $1 AND outcome = 'SUCCESS'),
         '-infinity'::timestamptz)`,
    [email, policy.window_minutes]
  );
  const candidates: Date[] = [];
  if (byEmail.rows[0].n >= policy.max_failures_per_email) candidates.push(byEmail.rows[0].oldest);

  if (ip) {
    const byIp = await client.query(
      `SELECT COUNT(*)::int AS n, MIN(attempted_at) AS oldest
       FROM crm_login_attempts
       WHERE ip_address = $1 AND outcome = 'FAILURE'
         AND attempted_at > CURRENT_TIMESTAMP - make_interval(mins => $2)`,
      [ip, policy.window_minutes]
    );
    if (byIp.rows[0].n >= policy.max_failures_per_ip) candidates.push(byIp.rows[0].oldest);
  }

  if (candidates.length === 0) return { locked: false, retryAfterSeconds: 0 };
  const windowMs = policy.window_minutes * 60 * 1000;
  const unlockAt = Math.max(...candidates.map((d) => new Date(d).getTime() + windowMs));
  return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000)) };
}

export async function recordLoginAttempt(
  client: PoolClient,
  email: string,
  ip: string | null,
  outcome: 'SUCCESS' | 'FAILURE' | 'LOCKED'
): Promise<void> {
  await client.query(
    `INSERT INTO crm_login_attempts (email, ip_address, outcome) VALUES ($1, $2, $3)`,
    [email, ip, outcome]
  );
}

/** Daily clean-up: drop attempt history older than the retention period. */
export async function purgeOldLoginAttempts(): Promise<number> {
  const policy = await getLoginSecurityPolicy();
  const res = await query(
    `DELETE FROM crm_login_attempts WHERE attempted_at < CURRENT_TIMESTAMP - make_interval(days => $1)`,
    [policy.retention_days]
  );
  return res.rowCount ?? 0;
}
