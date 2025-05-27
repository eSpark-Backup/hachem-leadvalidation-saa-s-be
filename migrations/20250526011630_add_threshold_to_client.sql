-- Migration: Add client threshold settings (simplified - no supplier relationships)
-- Created at: 2025-05-26T10:00:00.000Z

-- Add client_settings table for client preferences
CREATE TABLE client_settings
(
    id                 SERIAL PRIMARY KEY,
    client_id          INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    min_lead_score     INTEGER   DEFAULT 70 CHECK (min_lead_score >= 0 AND min_lead_score <= 100),
    auto_accept_leads  BOOLEAN   DEFAULT true,
    notification_email BOOLEAN   DEFAULT true,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (client_id)
);

-- Remove threshold from lead_uploads (it should come from client settings)
ALTER TABLE lead_uploads
    DROP COLUMN IF EXISTS threshold;

-- Add indexes for performance
CREATE INDEX idx_client_settings_client_id ON client_settings (client_id);

-- Add trigger for updated_at on client_settings
CREATE TRIGGER client_settings_update_timestamp
    BEFORE UPDATE
    ON client_settings
    FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Insert default settings for existing clients
INSERT INTO client_settings (client_id, min_lead_score)
SELECT id, 70
FROM users
WHERE role = 'client'
ON CONFLICT (client_id) DO NOTHING;

ALTER TABLE leads
    ADD COLUMN client_updated_at TIMESTAMP;

-- Add index for better performance
CREATE INDEX idx_leads_client_updated ON leads(client_updated_at);

-- Comments for documentation
COMMENT ON COLUMN leads.client_status IS 'Status set by client: contacted, sold, invalid, duplicate, etc.';
COMMENT ON COLUMN leads.client_updated_at IS 'Timestamp when client last updated the lead status';
COMMENT ON TABLE client_settings IS 'Client preferences and thresholds for lead acceptance';
COMMENT ON COLUMN client_settings.min_lead_score IS 'Minimum score threshold for lead acceptance (0-100)';
COMMENT ON COLUMN client_settings.auto_accept_leads IS 'Whether to automatically accept leads above threshold';
COMMENT ON COLUMN client_settings.notification_email IS 'Whether to send email notifications for new leads';