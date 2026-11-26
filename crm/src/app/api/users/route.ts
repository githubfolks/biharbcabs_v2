import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword, requireAdmin } from '@/lib/auth';
import { ROLES, Role } from '@/lib/permissions';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 10;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'users.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await query(
      `SELECT
         u.id,
         u.email,
         u.full_name,
         u.role,
         u.phone,
         u.is_active,
         u.last_login_at,
         u.created_at,
         u.updated_at,
         COUNT(s.id) FILTER (WHERE s.expires_at > CURRENT_TIMESTAMP)::int AS active_sessions
       FROM crm_admin_users u
       LEFT JOIN crm_admin_sessions s ON s.user_id = u.id
       GROUP BY u.id
       ORDER BY u.id ASC`
    );
    return NextResponse.json({ success: true, users: res.rows, roles: ROLES });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'users.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const email = String(body.email || '').trim().toLowerCase();
    const fullName = String(body.full_name || '').trim().slice(0, 150);
    const role = String(body.role || '').trim() as Role;
    const phone = body.phone ? String(body.phone).trim().slice(0, 20) : null;
    const password = String(body.password || '');

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ success: false, error: 'Please provide a valid email address.' }, { status: 400 });
    }
    if (!fullName) {
      return NextResponse.json({ success: false, error: 'Full name is required.' }, { status: 400 });
    }
    if (!(ROLES as readonly string[]).includes(role)) {
      return NextResponse.json({ success: false, error: `Invalid role. Must be one of: ${ROLES.join(', ')}` }, { status: 400 });
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return NextResponse.json(
        { success: false, error: `Password must be at least ${MIN_PASSWORD_LEN} characters long.` },
        { status: 400 }
      );
    }

    const existing = await query(`SELECT id FROM crm_admin_users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    if (existing.rows.length > 0) {
      return NextResponse.json({ success: false, error: 'An admin account with this email already exists.' }, { status: 409 });
    }

    const { hash, salt } = hashPassword(password);
    const inserted = await query(
      `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, phone, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, email, full_name, role, phone, is_active, last_login_at, created_at`,
      [email, hash, salt, fullName, role, phone]
    );
    const user = inserted.rows[0];

    await recordAuditLog({
      actor: auth,
      action: 'USER_CREATED',
      entityType: 'ADMIN_USER',
      entityId: user.id,
      summary: `Created staff account ${user.email} (${user.role})`,
      afterData: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, phone: user.phone, is_active: true },
      req,
    });

    return NextResponse.json({ success: true, user: { ...user, active_sessions: 0 } }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
