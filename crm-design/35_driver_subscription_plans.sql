-- ==============================================================================
-- Migration 35: Driver Subscription Plans (Prepaid Commission Balance)
-- ==============================================================================
-- Specification: crm-design/driver_plans_design.md
-- Drivers purchase prepaid commission plans (Local, Outstation, Premium) via
-- Razorpay Payment Links. BiharCabs' share of each ride is reserved at acceptance
-- and deducted at trip completion; released on cancellation/reassignment.
-- Safe to run more than once.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Subscription Plan Catalog (fully dynamic, configured by Super Admin)
CREATE TABLE IF NOT EXISTS crm_subscription_plans (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    price_incl_gst NUMERIC(12, 2) NOT NULL CHECK (price_incl_gst > 0),
    gst_pct NUMERIC(5, 2) NOT NULL DEFAULT 18.00 CHECK (gst_pct >= 0 AND gst_pct <= 28),
    allowed_trip_types TEXT[] NOT NULL DEFAULT ARRAY['LOCAL', 'RENTAL'],
    max_fare_limit NUMERIC(12, 2) CHECK (max_fare_limit IS NULL OR max_fare_limit > 0),
    priority_rank INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Driver Active / Historical Plans
CREATE TABLE IF NOT EXISTS crm_driver_plans (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE RESTRICT,
    plan_id BIGINT NOT NULL REFERENCES crm_subscription_plans(id) ON DELETE RESTRICT,
    plan_code VARCHAR(40) NOT NULL,
    plan_name VARCHAR(100) NOT NULL,
    allowed_trip_types TEXT[] NOT NULL,
    max_fare_limit NUMERIC(12, 2),
    priority_rank INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING_PAYMENT'
        CHECK (status IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'EXHAUSTED', 'SUPERSEDED', 'CANCELLED')),
    amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    taxable_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    gst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    balance_remaining NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (balance_remaining >= 0),
    reserved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (reserved_amount >= 0),
    invoice_number VARCHAR(50),
    activated_at TIMESTAMPTZ,
    exhausted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- At most one active or paused plan per driver.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_driver_plans_live
    ON crm_driver_plans (driver_id)
    WHERE status IN ('ACTIVE', 'PAUSED');

CREATE INDEX IF NOT EXISTS idx_crm_driver_plans_driver ON crm_driver_plans (driver_id, status);

-- 3. Append-only Audit Trail of Plan Balance Movements
CREATE TABLE IF NOT EXISTS crm_driver_plan_movements (
    id BIGSERIAL PRIMARY KEY,
    driver_plan_id BIGINT NOT NULL REFERENCES crm_driver_plans(id) ON DELETE RESTRICT,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE RESTRICT,
    booking_id BIGINT REFERENCES crm_bookings(id) ON DELETE SET NULL,
    movement_type VARCHAR(30) NOT NULL
        CHECK (movement_type IN ('PURCHASE', 'TOPUP', 'CARRY_OVER_OUT', 'CARRY_OVER_IN', 'RESERVE', 'RELEASE', 'DEDUCT')),
    amount NUMERIC(12, 2) NOT NULL,
    balance_after NUMERIC(12, 2) NOT NULL,
    reserved_after NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reference_id VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_plan_movements_plan ON crm_driver_plan_movements (driver_plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_plan_movements_booking ON crm_driver_plan_movements (booking_id) WHERE booking_id IS NOT NULL;

-- 4. Booking Billing Model & Reservation Tracking
ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS billing_model VARCHAR(20) NOT NULL DEFAULT 'COMMISSION'
        CHECK (billing_model IN ('COMMISSION', 'PLAN')),
    ADD COLUMN IF NOT EXISTS driver_plan_id BIGINT REFERENCES crm_driver_plans(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS plan_amount_reserved NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

-- 5. Extend crm_payment_links to support DRIVER_PLAN purchases (alongside DRIVER_DUES and legacy ADVANCE rows)
ALTER TABLE crm_payment_links
    ADD COLUMN IF NOT EXISTS driver_plan_id BIGINT REFERENCES crm_driver_plans(id) ON DELETE RESTRICT;

ALTER TABLE crm_payment_links DROP CONSTRAINT IF EXISTS chk_crm_payment_links_owner;
ALTER TABLE crm_payment_links ADD CONSTRAINT chk_crm_payment_links_owner CHECK (
    (purpose = 'ADVANCE' AND booking_id IS NOT NULL)
    OR (purpose = 'DRIVER_DUES' AND driver_id IS NOT NULL AND booking_id IS NULL)
    OR (purpose = 'DRIVER_PLAN' AND driver_id IS NOT NULL AND driver_plan_id IS NOT NULL AND booking_id IS NULL)
);

-- 6. Dynamic Driver Plans Policy setting (off at launch until enough drivers hold plans)
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'driver_plans_policy',
    '{
        "plan_only_rides_enabled": false,
        "plan_gst_pct": 18.0
    }'::jsonb,
    'Driver subscription plan rules: whether outstation rides are plan-only and GST % on plan purchase'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('35', 'Driver subscription plans prepaid commission balance')
ON CONFLICT (version) DO NOTHING;
