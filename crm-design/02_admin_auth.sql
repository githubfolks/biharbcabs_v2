-- ==============================================================================
-- BiharCabs Operational CRM: Admin Users & Authentication Tables
-- ==============================================================================

CREATE TABLE IF NOT EXISTS crm_admin_users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'SUPER_ADMIN', -- SUPER_ADMIN, DISPATCHER, FINANCE_MANAGER
    phone VARCHAR(20),
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_admin_users_email ON crm_admin_users(email);

CREATE TABLE IF NOT EXISTS crm_admin_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES crm_admin_users(id) ON DELETE CASCADE,
    session_token VARCHAR(128) NOT NULL UNIQUE,
    user_agent TEXT,
    ip_address VARCHAR(50),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_admin_sessions_token ON crm_admin_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_crm_admin_sessions_expiry ON crm_admin_sessions(expires_at);

-- No default admin is seeded: a published default password would let anyone in.
-- Create the first admin with: CRM_ADMIN_EMAIL=you@example.com node crm/scripts/set-admin-password.mjs

