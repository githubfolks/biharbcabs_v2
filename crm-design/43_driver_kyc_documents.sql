-- ==============================================================================
-- Migration 43: Driver KYC & Vehicle Document Vault
-- ==============================================================================

CREATE TABLE IF NOT EXISTS crm_driver_documents (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE CASCADE,
    vehicle_id BIGINT REFERENCES crm_driver_vehicles(id) ON DELETE SET NULL,
    doc_type VARCHAR(40) NOT NULL,
    doc_number VARCHAR(80),
    expiry_date DATE,
    original_filename VARCHAR(255) NOT NULL,
    stored_filename VARCHAR(255) NOT NULL UNIQUE,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    verification_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
    verified_by BIGINT REFERENCES crm_admin_users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    rejection_reason TEXT,
    uploaded_by BIGINT REFERENCES crm_admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_driver_docs_driver ON crm_driver_documents(driver_id, doc_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_driver_docs_status ON crm_driver_documents(verification_status);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON crm_driver_documents TO crm_app;
        GRANT USAGE, SELECT ON SEQUENCE crm_driver_documents_id_seq TO crm_app;
    END IF;
END $$;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('43', 'Driver KYC and vehicle document upload vault')
ON CONFLICT (version) DO NOTHING;
