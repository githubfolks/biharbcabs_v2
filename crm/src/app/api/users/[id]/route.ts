import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { hashPassword, requireAdmin } from '@/lib/auth';
import { ROLES, Role } from '@/lib/permissions';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

const MIN_PASSWORD_LEN = 10;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'users.manage');
  if (auth instanceof NextResponse) return auth;

  const targetId = Number(params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid user ID.' }, { status: 400 });
  }

  try {
    const existingRes = await query(
      `SELECT id, email, full_name, role, phone, is_active, last_login_at, created_at
       FROM crm_admin_users WHERE id = $1 LIMIT 1`,
      [targetId]
    );
    if (existingRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Admin user not found.' }, { status: 404 });
    }
    const before = existingRes.rows[0];
    const body = await req.json();

    // Pure session revocation action
    if (body.revoke_sessions === true && body.new_password === undefined && body.is_active === undefined && body.role === undefined && body.full_name === undefined) {
      const del = await query(`DELETE FROM crm_admin_sessions WHERE user_id = $1`, [targetId]);
      await recordAuditLog({
        actor: auth,
        action: 'USER_SESSIONS_REVOKED',
        entityType: 'ADMIN_USER',
        entityId: targetId,
        summary: `Revoked ${del.rowCount || 0} active session(s) for ${before.email}`,
        afterData: { revoked_sessions: del.rowCount || 0 },
        req,
      });
      return NextResponse.json({ success: true, revoked_sessions: del.rowCount || 0 });
    }

    const nextFullName =
      body.full_name !== undefined ? String(body.full_name).trim().slice(0, 150) : before.full_name;
    const nextRole = (body.role !== undefined ? String(body.role).trim() : before.role) as Role;
    const nextPhone =
      body.phone !== undefined ? (body.phone ? String(body.phone).trim().slice(0, 20) : null) : before.phone;
    const nextActive = body.is_active !== undefined ? Boolean(body.is_active) : before.is_active;
    const newPassword = body.new_password !== undefined ? String(body.new_password) : '';

    if (!nextFullName) {
      return NextResponse.json({ success: false, error: 'Full name cannot be empty.' }, { status: 400 });
    }
    if (!(ROLES as readonly string[]).includes(nextRole)) {
      return NextResponse.json({ success: false, error: `Invalid role. Must be one of: ${ROLES.join(', ')}` }, { status: 400 });
    }
    if (targetId === Number(auth.id)) {
      if (!nextActive) {
        return NextResponse.json({ success: false, error: 'You cannot deactivate your own admin account.' }, { status: 400 });
      }
      if (nextRole !== 'SUPER_ADMIN') {
        return NextResponse.json({ success: false, error: 'You cannot remove SUPER_ADMIN from your own account.' }, { status: 400 });
      }
    }
    if (newPassword && newPassword.length < MIN_PASSWORD_LEN) {
      return NextResponse.json(
        { success: false, error: `New password must be at least ${MIN_PASSWORD_LEN} characters long.` },
        { status: 400 }
      );
    }

    let updatedRow;
    if (newPassword) {
      const { hash, salt } = hashPassword(newPassword);
      const upd = await query(
        `UPDATE crm_admin_users
         SET full_name = $1, role = $2, phone = $3, is_active = $4, password_hash = $5, salt = $6, updated_at = CURRENT_TIMESTAMP
         WHERE id = $7
         RETURNING id, email, full_name, role, phone, is_active, last_login_at, created_at, updated_at`,
        [nextFullName, nextRole, nextPhone, nextActive, hash, salt, targetId]
      );
      updatedRow = upd.rows[0];
    } else {
      const upd = await query(
        `UPDATE crm_admin_users
         SET full_name = $1, role = $2, phone = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING id, email, full_name, role, phone, is_active, last_login_at, created_at, updated_at`,
        [nextFullName, nextRole, nextPhone, nextActive, targetId]
      );
      updatedRow = upd.rows[0];
    }

    // Revoke all sessions if deactivated, password changed, or explicitly requested
    let revokedCount = 0;
    if (!nextActive || Boolean(newPassword) || body.revoke_sessions === true) {
      const del = await query(`DELETE FROM crm_admin_sessions WHERE user_id = $1`, [targetId]);
      revokedCount = del.rowCount || 0;
    }

    const actions: string[] = [];
    if (before.role !== nextRole) actions.push(`role ${before.role} -> ${nextRole}`);
    if (before.is_active !== nextActive) actions.push(nextActive ? 'activated' : 'deactivated');
    if (newPassword) actions.push('password reset');
    if (revokedCount > 0) actions.push(`revoked ${revokedCount} session(s)`);
    if (actions.length === 0) actions.push('profile updated');

    await recordAuditLog({
      actor: auth,
      action: newPassword ? 'USER_PASSWORD_RESET' : 'USER_UPDATED',
      entityType: 'ADMIN_USER',
      entityId: targetId,
      summary: `Updated ${before.email}: ${actions.join(', ')}`,
      beforeData: { full_name: before.full_name, role: before.role, phone: before.phone, is_active: before.is_active },
      afterData: {
        full_name: updatedRow.full_name,
        role: updatedRow.role,
        phone: updatedRow.phone,
        is_active: updatedRow.is_active,
        password_changed: Boolean(newPassword),
        revoked_sessions: revokedCount,
      },
      req,
    });

    const sessRes = await query(
      `SELECT COUNT(*)::int AS active_sessions FROM crm_admin_sessions WHERE user_id = $1 AND expires_at > CURRENT_TIMESTAMP`,
      [targetId]
    );

    return NextResponse.json({
      success: true,
      user: { ...updatedRow, active_sessions: sessRes.rows[0]?.active_sessions ?? 0 },
    });
  } catch (err: any) {
    return handleRouteError(err, 'API users/[id]');
  }
}
