-- ==============================================================================
-- Migration 40: Manageable Cab Type Image URL
-- ==============================================================================
ALTER TABLE crm_cab_types
  ADD COLUMN IF NOT EXISTS image_url TEXT;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('40', 'Add image_url column to crm_cab_types for CRM-managed frontend cab images')
ON CONFLICT (version) DO NOTHING;
