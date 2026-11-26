-- ==============================================================================
-- Migration 48: Dynamic Route SEO Pages (WordPress <-> CRM)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS crm_seo_routes (
    id BIGSERIAL PRIMARY KEY,
    slug VARCHAR(120) NOT NULL UNIQUE,
    origin_city VARCHAR(100) NOT NULL,
    destination_city VARCHAR(100),
    booking_type VARCHAR(30) NOT NULL DEFAULT 'OUTSTATION'
        CHECK (booking_type IN ('OUTSTATION', 'LOCAL', 'RENTAL')),
    page_title VARCHAR(180) NOT NULL,
    meta_description VARCHAR(320) NOT NULL,
    hero_heading VARCHAR(180) NOT NULL,
    intro_copy TEXT,
    distance_km NUMERIC(8, 2),
    drive_time_text VARCHAR(60),
    faqs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_published BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_seo_routes_published ON crm_seo_routes(is_published, slug);

-- Seed 3 initial Bihar flagship corridors (editable/deletable from CRM /catalog)
INSERT INTO crm_seo_routes (slug, origin_city, destination_city, booking_type, page_title, meta_description, hero_heading, intro_copy, distance_km, drive_time_text, faqs_json)
VALUES
(
    'patna-to-darbhanga-cab',
    'Patna',
    'Darbhanga',
    'OUTSTATION',
    'Patna to Darbhanga Cab Booking | Verified Drivers & Transparent Fares - BiharCabs',
    'Book a verified AC cab from Patna to Darbhanga with instant WhatsApp confirmation, transparent GST fares, and 24/7 support.',
    'Patna to Darbhanga Cab Service',
    'Travel comfortably from Patna to Darbhanga in verified AC Hatchback, Sedan, or SUV cabs with transparent all-inclusive pricing.',
    138,
    '3 hrs 30 mins',
    '[{"q":"How far is Darbhanga from Patna by road?","a":"The road distance from Patna to Darbhanga is approximately 138 km and takes around 3.5 hours depending on traffic."},{"q":"Are tolls and GST included?","a":"All fares shown include GST and platform charges. Any highway toll or parking charges are payable directly as per actuals."}]'::jsonb
),
(
    'katihar-to-purnia-taxi',
    'Katihar',
    'Purnia',
    'OUTSTATION',
    'Katihar to Purnia Taxi Service | Instant AC Cab Booking - BiharCabs',
    'Book reliable AC cabs from Katihar to Purnia with KYC-verified drivers, transparent packages, and instant WhatsApp booking.',
    'Katihar to Purnia Taxi Booking',
    'Quick, comfortable outstation and round-trip cabs between Katihar and Purnia with verified local chauffeurs.',
    55,
    '1 hr 20 mins',
    '[{"q":"How long does Katihar to Purnia take by cab?","a":"Katihar to Purnia is around 55 km by road and typically takes 1 hour 15 to 30 minutes."}]'::jsonb
),
(
    'patna-airport-cab',
    'Patna',
    'Patna Airport',
    'LOCAL',
    'Patna Airport Taxi & Pickup Drop Service | 24/7 AC Cabs - BiharCabs',
    'Book punctual Patna Airport (Jay Prakash Narayan International Airport) pickup and drop cabs with live driver tracking and verified chauffeurs.',
    'Patna Airport Pickup & Drop Cabs',
    'On-time airport transfers across Patna with clean AC cabs, verified drivers, and instant WhatsApp OTP confirmation.',
    15,
    '35 mins',
    '[{"q":"Is 24/7 Patna Airport pickup available?","a":"Yes, BiharCabs operates 24/7 for early-morning and late-night flight pickups and drops in Patna."}]'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON crm_seo_routes TO crm_app;
        GRANT USAGE, SELECT ON SEQUENCE crm_seo_routes_id_seq TO crm_app;
    END IF;
END $$;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('48', 'Dynamic Route SEO pages (WordPress <-> CRM)')
ON CONFLICT (version) DO NOTHING;
