import crypto from 'crypto';
import { query } from './db';
import { cookies } from 'next/headers';

export interface AdminUser {
  id: number;
  email: string;
  full_name: string;
  role: string;
  phone?: string;
  is_active: boolean;
  last_login_at?: Date;
}

const SESSION_COOKIE_NAME = 'biharcabs_crm_session';
const SESSION_TTL_DAYS = 7;

/**
 * Hash password securely using Node.js crypto.scrypt.
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

/**
 * Verify password against stored hash and salt with constant-time equality check.
 */
export function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  try {
    const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(computedHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Create a new admin session token in crm_admin_sessions.
 */
export async function createAdminSession(
  userId: number,
  userAgent?: string,
  ipAddress?: string
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO crm_admin_sessions (user_id, session_token, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, token, userAgent || null, ipAddress || null, expiresAt]
  );

  // Update last_login_at on admin user
  await query(
    `UPDATE crm_admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [userId]
  );

  return { token, expiresAt };
}

/**
 * Validate a session token against crm_admin_sessions and return user info.
 */
export async function validateSession(token: string): Promise<AdminUser | null> {
  if (!token) return null;

  const sql = `
    SELECT 
      u.id, u.email, u.full_name, u.role, u.phone, u.is_active, u.last_login_at
    FROM crm_admin_sessions s
    JOIN crm_admin_users u ON u.id = s.user_id
    WHERE s.session_token = $1
      AND s.expires_at > CURRENT_TIMESTAMP
      AND u.is_active = true
    LIMIT 1;
  `;

  const res = await query(sql, [token]);
  if (res.rows.length === 0) return null;

  return res.rows[0];
}

/**
 * Revoke a session token upon logout.
 */
export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await query(`DELETE FROM crm_admin_sessions WHERE session_token = $1`, [token]);
}

/**
 * Helper to get the currently authenticated admin from Next.js cookies.
 */
export async function getCurrentAdmin(): Promise<AdminUser | null> {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;
    return await validateSession(token);
  } catch {
    return null;
  }
}

export { SESSION_COOKIE_NAME };

