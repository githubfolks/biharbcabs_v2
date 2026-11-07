#!/usr/bin/env node
/**
 * Create a CRM admin, or reset an existing admin's password, and sign out that admin's sessions.
 *
 *   CRM_ADMIN_EMAIL=you@example.com node scripts/set-admin-password.mjs
 *
 * Optional: CRM_ADMIN_PASSWORD (otherwise a strong one is generated and printed once),
 * CRM_ADMIN_NAME and CRM_ADMIN_ROLE (both used only when creating). Connects with DATABASE_URL,
 * or the standard PG* variables. The hash format matches hashPassword() in src/lib/auth.ts.
 */
import crypto from 'crypto';
import pg from 'pg';

const email = (process.env.CRM_ADMIN_EMAIL || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Set CRM_ADMIN_EMAIL to the admin email address.');
  process.exit(1);
}

const ROLES = ['SUPER_ADMIN', 'DISPATCHER', 'FINANCE_MANAGER'];
const role = process.env.CRM_ADMIN_ROLE || 'SUPER_ADMIN';
if (!ROLES.includes(role)) {
  console.error(`CRM_ADMIN_ROLE must be one of: ${ROLES.join(', ')}`);
  process.exit(1);
}

const generated = !process.env.CRM_ADMIN_PASSWORD;
const password = process.env.CRM_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
if (password.length < 12) {
  console.error('CRM_ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

const client = new pg.Client(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt, updated_at = CURRENT_TIMESTAMP
     RETURNING id, (xmax = 0) AS created`,
    [email, hash, salt, process.env.CRM_ADMIN_NAME || 'Operations Super Admin', role]
  );
  const { rowCount } = await client.query('DELETE FROM crm_admin_sessions WHERE user_id = $1', [rows[0].id]);
  await client.query('COMMIT');
  console.log(`${rows[0].created ? 'Created' : 'Reset password for'} ${email}; signed out ${rowCount} session(s).`);
  if (generated) console.log(`New password (shown once, store it safely): ${password}`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
