-- ==============================================================================
-- Migration 34: Cab Types (by Fuel Type), Fuel Prices, and Booking Packages
-- ==============================================================================
-- Makes the CRM the single source of truth for cab configurations, live fuel
-- prices, and booking packages (OUTSTATION, LOCAL, RENTAL). All pricing values
-- are dynamically configurable via CRM Admin UI/APIs (zero hardcoded values).
-- Safe to run more than once.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Fuel Prices (maintained dynamically by CRM Admin)
CREATE TABLE IF NOT EXISTS crm_fuel_prices (
    fuel_type VARCHAR(20) PRIMARY KEY CHECK (fuel_type IN ('PETROL', 'CNG', 'DIESEL')),
    price_per_unit NUMERIC(10, 2) NOT NULL CHECK (price_per_unit >= 0),
    unit VARCHAR(20) NOT NULL DEFAULT 'LITRE',
    updated_by BIGINT REFERENCES crm_admin_users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed fuel types; PETROL & DIESEL from Biharcabs Cab Plans.xlsx, CNG set to 0 until configured by admin.
INSERT INTO crm_fuel_prices (fuel_type, price_per_unit, unit)
VALUES
    ('PETROL', 115.00, 'LITRE'),
    ('DIESEL', 98.00, 'LITRE'),
    ('CNG', 0.00, 'KG')
ON CONFLICT (fuel_type) DO NOTHING;

-- 2. Cab Types separated by Fuel Type (PDCRG, PHEXCHG, extra_km_charge, CML, Driver TA)
CREATE TABLE IF NOT EXISTS crm_cab_types (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    code VARCHAR(64) NOT NULL UNIQUE,
    category VARCHAR(30) NOT NULL CHECK (category IN ('MICRO', 'MINI', 'SEDAN', 'PRIME_SEDAN', 'SUV', 'LUX', 'BIKE')),
    display_name VARCHAR(100) NOT NULL,
    fuel_type VARCHAR(20) NOT NULL REFERENCES crm_fuel_prices(fuel_type) ON DELETE RESTRICT,
    mileage_kmpl NUMERIC(8, 2) NOT NULL CHECK (mileage_kmpl > 0),
    per_day_charge NUMERIC(12, 2) NOT NULL CHECK (per_day_charge >= 0),
    base_buffer_minutes INTEGER NOT NULL DEFAULT 30 CHECK (base_buffer_minutes >= 0 AND base_buffer_minutes <= 180),
    extra_hour_charge NUMERIC(10, 2) NOT NULL CHECK (extra_hour_charge >= 0),
    extra_km_charge NUMERIC(10, 2) NOT NULL CHECK (extra_km_charge >= 0),
    driver_ta NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (driver_ta >= 0),
    seating_capacity INTEGER NOT NULL DEFAULT 4 CHECK (seating_capacity > 0),
    luggage_bags INTEGER NOT NULL DEFAULT 2 CHECK (luggage_bags >= 0),
    models_description VARCHAR(200),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (category, fuel_type)
);

CREATE INDEX IF NOT EXISTS idx_crm_cab_types_active ON crm_cab_types (is_active, category);

-- Seed initial cab types from Biharcabs Cab Plans.xlsx (all editable in CRM Catalog UI).
-- BIKE is seeded inactive until admin configures its exact rates.
INSERT INTO crm_cab_types (
    code, category, display_name, fuel_type, mileage_kmpl,
    per_day_charge, base_buffer_minutes, extra_hour_charge, extra_km_charge,
    driver_ta, seating_capacity, luggage_bags, models_description, is_active
) VALUES
    ('MICRO_PETROL',       'MICRO',       'Micro (Petrol)',       'PETROL', 15.00,  800.00, 30, 180.00, 16.00,  0.00, 4, 1, 'Alto, Kwid, S-Presso', true),
    ('MINI_PETROL',        'MINI',        'Mini (Petrol)',        'PETROL', 10.00, 1000.00, 30, 120.00, 16.00,  0.00, 4, 2, 'WagonR, Swift, Celerio', true),
    ('SEDAN_PETROL',       'SEDAN',       'Sedan (Petrol)',       'PETROL', 10.00, 1100.00, 30, 180.00, 15.00,  0.00, 4, 3, 'Dzire, Etios, Aura', true),
    ('PRIME_SEDAN_PETROL', 'PRIME_SEDAN', 'Prime Sedan (Petrol)', 'PETROL', 10.00, 1200.00, 30, 210.00, 14.50, 50.00, 4, 3, 'Honda City, Ciaz, Amaze Prime', true),
    ('SUV_PETROL',         'SUV',         'SUV (Petrol)',         'PETROL',  8.00, 1500.00, 30, 150.00, 18.00, 50.00, 6, 4, 'Ertiga, Carens, Triber', true),
    ('LUX_DIESEL',         'LUX',         'Luxury (Diesel)',      'DIESEL',  8.00, 2000.00, 30, 240.00, 22.00, 50.00, 6, 4, 'Innova Crysta, Hycross', true),
    ('BIKE_PETROL',        'BIKE',        'Bike (Petrol)',        'PETROL', 45.00,    0.00,  0,   0.00,  0.00,  0.00, 1, 0, 'Two-Wheeler', false)
ON CONFLICT (code) DO NOTHING;

-- 3. Booking Packages / Plans (configured in CRM Admin, fetched by WordPress & Operator UI)
CREATE TABLE IF NOT EXISTS crm_packages (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    booking_type VARCHAR(30) NOT NULL CHECK (booking_type IN ('OUTSTATION', 'LOCAL', 'RENTAL')),
    sub_type VARCHAR(50),
    cab_type_id BIGINT NOT NULL REFERENCES crm_cab_types(id) ON DELETE RESTRICT,
    included_km NUMERIC(10, 2) NOT NULL CHECK (included_km > 0),
    included_hours NUMERIC(8, 2) NOT NULL CHECK (included_hours > 0),
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_packages_active_type ON crm_packages (is_active, booking_type, sort_order);

-- 4. Link Bookings to Packages & Snapshot Applied Rates (protects past bookings from future rate edits)
ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS package_id BIGINT REFERENCES crm_packages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cab_type_id BIGINT REFERENCES crm_cab_types(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(20),
    ADD COLUMN IF NOT EXISTS included_km NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS included_hours NUMERIC(8, 2),
    ADD COLUMN IF NOT EXISTS base_fare_pre_gst NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS applied_gst_pct NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS applied_commission_pct NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS applied_extra_hour_charge NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS applied_extra_km_charge NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS booking_source VARCHAR(30) NOT NULL DEFAULT 'CRM';

CREATE INDEX IF NOT EXISTS idx_crm_bookings_package ON crm_bookings (package_id) WHERE package_id IS NOT NULL;

-- 5. Optional link on driver vehicles to canonical cab category
ALTER TABLE crm_driver_vehicles
    ADD COLUMN IF NOT EXISTS cab_type_id BIGINT REFERENCES crm_cab_types(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(20);

INSERT INTO crm_schema_migrations (version, description)
VALUES ('34', 'Cab types by fuel, fuel prices, and booking packages')
ON CONFLICT (version) DO NOTHING;
