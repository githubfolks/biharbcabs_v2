-- ==============================================================================
-- BiharCabs Operational CRM: WhatsApp State Machine & Conversation Tracking
-- ==============================================================================

CREATE TABLE IF NOT EXISTS crm_whatsapp_conversations (
    phone VARCHAR(20) PRIMARY KEY,
    state VARCHAR(50) NOT NULL DEFAULT 'IDLE',
    role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER', -- CUSTOMER, DRIVER, ADMIN
    context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_wa_conv_state ON crm_whatsapp_conversations(state);
CREATE INDEX IF NOT EXISTS idx_crm_wa_conv_last_msg ON crm_whatsapp_conversations(last_message_at DESC);

