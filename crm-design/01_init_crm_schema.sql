-- ==============================================================================
-- BiharCabs Operational CRM Schema (Native PostgreSQL)
-- Specification: biharcabs_whatsapp_crm_design.md
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. CRM Settings (Dynamic Key-Value Store for zero hardcoded configs)
CREATE TABLE IF NOT EXISTS crm_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. CRM Customers
CREATE TABLE IF NOT EXISTS crm_customers (
    id BIGSERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL UNIQUE,
    full_name VARCHAR(150),
    email VARCHAR(150),
    gstin VARCHAR(20),
    company_name VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_customers_phone ON crm_customers(phone);

-- 3. CRM Drivers
CREATE TABLE IF NOT EXISTS crm_drivers (
    id BIGSERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL UNIQUE,
    whatsapp_phone VARCHAR(20) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    base_city VARCHAR(100) NOT NULL,
    onboarding_status VARCHAR(50) NOT NULL DEFAULT 'PENDING_DOCS',
    license_number VARCHAR(50),
    license_expiry DATE,
    wallet_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    max_negative_balance NUMERIC(12, 2) NOT NULL DEFAULT 1500.00,
    is_available BOOLEAN NOT NULL DEFAULT true,
    rating NUMERIC(3, 2) NOT NULL DEFAULT 5.00,
    bank_upi_id VARCHAR(100),
    bank_account_number VARCHAR(50),
    bank_ifsc VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_drivers_city_status ON crm_drivers(base_city, onboarding_status, is_available);
CREATE INDEX IF NOT EXISTS idx_crm_drivers_whatsapp ON crm_drivers(whatsapp_phone);

-- 4. CRM Driver Vehicles
CREATE TABLE IF NOT EXISTS crm_driver_vehicles (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE CASCADE,
    wp_vehicle_code VARCHAR(64) NOT NULL,
    registration_no VARCHAR(50) NOT NULL UNIQUE,
    model_name VARCHAR(100) NOT NULL,
    insurance_expiry DATE,
    fitness_expiry DATE,
    permit_expiry DATE,
    puc_expiry DATE,
    is_verified BOOLEAN NOT NULL DEFAULT false,
    vehicle_photos JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_vehicles_driver ON crm_driver_vehicles(driver_id);
CREATE INDEX IF NOT EXISTS idx_crm_vehicles_category ON crm_driver_vehicles(wp_vehicle_code, is_verified);

-- 5. CRM Bookings
CREATE TABLE IF NOT EXISTS crm_bookings (
    id BIGSERIAL PRIMARY KEY,
    booking_code VARCHAR(30) NOT NULL UNIQUE,
    customer_id BIGINT NOT NULL REFERENCES crm_customers(id),
    assigned_driver_id BIGINT REFERENCES crm_drivers(id),
    assigned_vehicle_id BIGINT REFERENCES crm_driver_vehicles(id),
    trip_type VARCHAR(50) NOT NULL,
    origin_city VARCHAR(100) NOT NULL,
    destination_city VARCHAR(100),
    pickup_address TEXT NOT NULL,
    drop_address TEXT,
    pickup_date DATE NOT NULL,
    pickup_time TIME NOT NULL,
    wp_vehicle_code VARCHAR(64) NOT NULL,
    distance_km NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    customer_total_fare NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    driver_payout_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    commission_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    advance_paid NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    cash_collected_by_driver NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    opening_km NUMERIC(10, 2),
    closing_km NUMERIC(10, 2),
    toll_parking_charges NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    extra_km_charges NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    extra_hour_charges NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    booking_status VARCHAR(50) NOT NULL DEFAULT 'INQUIRY_OPEN',
    payment_status VARCHAR(50) NOT NULL DEFAULT 'UNPAID',
    driver_broadcast_at TIMESTAMPTZ,
    sla_deadline_at TIMESTAMPTZ,
    special_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_bookings_status ON crm_bookings(booking_status);
CREATE INDEX IF NOT EXISTS idx_crm_bookings_pickup_date ON crm_bookings(pickup_date);
CREATE INDEX IF NOT EXISTS idx_crm_bookings_customer ON crm_bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_bookings_driver ON crm_bookings(assigned_driver_id);

-- 6. CRM Dispatch Offers (Ride broadcasts to drivers)
CREATE TABLE IF NOT EXISTS crm_dispatch_offers (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES crm_bookings(id) ON DELETE CASCADE,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE CASCADE,
    offered_driver_fare NUMERIC(12, 2) NOT NULL,
    offer_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_offers_booking ON crm_dispatch_offers(booking_id, offer_status);
CREATE INDEX IF NOT EXISTS idx_crm_offers_driver ON crm_dispatch_offers(driver_id);

-- 7. CRM Payments & Driver Wallet Ledger
CREATE TABLE IF NOT EXISTS crm_payments_ledger (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT REFERENCES crm_bookings(id) ON DELETE SET NULL,
    driver_id BIGINT REFERENCES crm_drivers(id) ON DELETE SET NULL,
    customer_id BIGINT REFERENCES crm_customers(id) ON DELETE SET NULL,
    transaction_type VARCHAR(50) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    payment_channel VARCHAR(50) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    reference_id VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_ledger_driver ON crm_payments_ledger(driver_id);
CREATE INDEX IF NOT EXISTS idx_crm_ledger_booking ON crm_payments_ledger(booking_id);

-- 8. CRM Invoices
CREATE TABLE IF NOT EXISTS crm_invoices (
    id BIGSERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) NOT NULL UNIQUE,
    booking_id BIGINT NOT NULL UNIQUE REFERENCES crm_bookings(id) ON DELETE RESTRICT,
    line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    pdf_path VARCHAR(512),
    sent_on_wa_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 9. CRM WhatsApp Message Logs (Full audit trail for incoming/outgoing messages)
CREATE TABLE IF NOT EXISTS crm_whatsapp_logs (
    id BIGSERIAL PRIMARY KEY,
    direction VARCHAR(10) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    message_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'RECEIVED',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_wa_logs_phone ON crm_whatsapp_logs(phone, created_at DESC);

-- 10. Seed Initial Dynamic Settings (Configurable via CRM Settings UI/API)
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES
    ('dispatch_sla_timeout_minutes', '{"value": 15}'::jsonb, 'Minutes before ride broadcast escalates to Admin alert (default: 15)'),
    ('driver_wakeup_check_hours_before', '{"value": 2}'::jsonb, 'Hours before pickup to trigger driver readiness WhatsApp check (default: 2)'),
    ('commission_model', '{"type": "PERCENTAGE", "percentage": 12.0, "fixed_margin": 300}'::jsonb, 'Commission calculation rules: PERCENTAGE or FIXED_MARGIN'),
    ('driver_max_negative_balance_limit', '{"value": 1500.0}'::jsonb, 'Max unpaid commission before driver is automatically blocked from broadcasts'),
    ('advance_token_amount', '{"type": "FIXED", "value": 500, "allow_admin_override": true}'::jsonb, 'Advance token required from customer for outstation booking'),
    ('whatsapp_templates', '{
        "driver_alert": "bc_driver_ride_alert",
        "customer_confirmation": "bc_customer_driver_confirmed",
        "admin_sla_alert": "bc_admin_unconfirmed_alert",
        "driver_wakeup": "bc_driver_wakeup_check",
        "customer_invoice": "bc_customer_trip_invoice"
    }'::jsonb, 'Meta WhatsApp Cloud API registered template names'),
    ('meta_whatsapp_config', '{
        "api_version": "v21.0",
        "phone_number_id": "",
        "business_account_id": "",
        "access_token": "",
        "webhook_verify_token": "biharcabs_crm_secure_token_2026"
    }'::jsonb, 'Meta WhatsApp Cloud API credentials and verify token'),
    ('admin_escalation_contacts', '[
        {"name": "Operations Admin", "phone": "917070992170", "role": "OPERATIONS_DISPATCH"}
    ]'::jsonb, 'Admin contacts alerted when driver acceptance SLA breaches'),
    ('biharcabs_wp_api', '{
        "base_url": "http://localhost:8080",
        "quote_endpoint": "/wp-json/biharcabs/v1/quote",
        "api_key": ""
    }'::jsonb, 'BiharCabs WordPress REST API base URL and endpoints'),
    ('company_billing_info', '{
        "legal_name": "Bihar Cabs",
        "trade_name": "BiharCabs.com",
        "phone": "+91 7070992170",
        "email": "contact@biharcabs.com",
        "address": "Patna, Bihar, India",
        "gstin": "",
        "tax_percentage": 5.0,
        "hsn_sac": "996601"
    }'::jsonb, 'Legal and invoicing entity details for customer bills')
ON CONFLICT (setting_key) DO NOTHING;

