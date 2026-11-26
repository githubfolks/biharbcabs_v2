-- ==============================================================================
-- Migration 47: Corporate B2B Accounts & Hotel/Travel-Desk Partner Program
-- ==============================================================================

CREATE TABLE IF NOT EXISTS crm_corporate_accounts (
    id BIGSERIAL PRIMARY KEY,
    company_name VARCHAR(160) NOT NULL,
    gstin VARCHAR(20),
    billing_address TEXT,
    contact_name VARCHAR(120) NOT NULL,
    contact_phone VARCHAR(20) NOT NULL,
    contact_email VARCHAR(150),
    credit_limit NUMERIC(12, 2) NOT NULL DEFAULT 50000.00 CHECK (credit_limit >= 0),
    current_outstanding NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    discount_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.00 CHECK (discount_pct >= 0 AND discount_pct <= 50),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_corporate_members (
    id BIGSERIAL PRIMARY KEY,
    corporate_account_id BIGINT NOT NULL REFERENCES crm_corporate_accounts(id) ON DELETE CASCADE,
    employee_name VARCHAR(120) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    department VARCHAR(80),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(corporate_account_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_crm_corp_members_phone ON crm_corporate_members(phone);

CREATE TABLE IF NOT EXISTS crm_partners (
    id BIGSERIAL PRIMARY KEY,
    partner_name VARCHAR(160) NOT NULL,
    partner_type VARCHAR(30) NOT NULL DEFAULT 'HOTEL'
        CHECK (partner_type IN ('HOTEL', 'TRAVEL_DESK', 'AGENT')),
    city VARCHAR(100) NOT NULL,
    contact_name VARCHAR(120) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    referral_code VARCHAR(40) NOT NULL UNIQUE,
    commission_type VARCHAR(20) NOT NULL DEFAULT 'PERCENT'
        CHECK (commission_type IN ('PERCENT', 'FLAT')),
    commission_value NUMERIC(10, 2) NOT NULL DEFAULT 5.00 CHECK (commission_value >= 0),
    wallet_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    upi_id VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_partners_ref ON crm_partners(referral_code);

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS corporate_account_id BIGINT REFERENCES crm_corporate_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS partner_id BIGINT REFERENCES crm_partners(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS partner_commission_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

CREATE INDEX IF NOT EXISTS idx_crm_bookings_corporate ON crm_bookings(corporate_account_id);
CREATE INDEX IF NOT EXISTS idx_crm_bookings_partner ON crm_bookings(partner_id);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON crm_corporate_accounts, crm_corporate_members, crm_partners TO crm_app;
        GRANT USAGE, SELECT ON SEQUENCE crm_corporate_accounts_id_seq, crm_corporate_members_id_seq, crm_partners_id_seq TO crm_app;
    END IF;
END $$;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('47', 'Corporate B2B accounts and Hotel/Travel-Desk partner program')
ON CONFLICT (version) DO NOTHING;
