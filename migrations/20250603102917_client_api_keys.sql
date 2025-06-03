-- Migration: Add client API keys support
-- Created at: 2025-06-03T12:00:00.000Z

-- Create client_api_keys table for client authentication
CREATE TABLE client_api_keys
(
    id            SERIAL PRIMARY KEY,
    client_id     INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key_name      VARCHAR(255) NOT NULL,
    api_key       VARCHAR(512) NOT NULL UNIQUE,
    key_prefix    VARCHAR(100) NOT NULL,
    is_active     BOOLEAN   DEFAULT true,
    last_used_at  TIMESTAMP,
    last_used_ip  VARCHAR(100),
    usage_count   INTEGER   DEFAULT 0,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by    INTEGER REFERENCES users (id),
    revoked_at    TIMESTAMP,
    revoked_by    INTEGER REFERENCES users (id),
    revoke_reason TEXT
);

-- Add indexes for performance
CREATE INDEX idx_client_api_keys_client_id ON client_api_keys (client_id);
CREATE INDEX idx_client_api_keys_api_key ON client_api_keys (api_key);
CREATE INDEX idx_client_api_keys_active ON client_api_keys (is_active);
CREATE INDEX idx_client_api_keys_prefix ON client_api_keys (key_prefix);

-- Add unique constraint on client_id + key_name to prevent duplicate names
CREATE UNIQUE INDEX idx_client_api_keys_client_name ON client_api_keys (client_id, key_name) WHERE is_active = true;

-- Add foreign key constraint to ensure client_id references valid users
-- The role validation will be handled at the application level
-- We'll add a trigger function to validate the client role

-- Create a function to validate client role
CREATE OR REPLACE FUNCTION validate_client_role()
    RETURNS TRIGGER AS
$$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.client_id AND role = 'client') THEN
        RAISE EXCEPTION 'client_id must reference a user with role "client"';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to validate client role on insert and update
CREATE TRIGGER validate_client_api_key_role
    BEFORE INSERT OR UPDATE
    ON client_api_keys
    FOR EACH ROW
EXECUTE FUNCTION validate_client_role();

-- Comments for documentation
COMMENT ON TABLE client_api_keys IS 'API keys for client authentication when fetching leads programmatically';
COMMENT ON COLUMN client_api_keys.api_key IS 'Full API key (64 characters) starting with ck_ - should be hashed in production';
COMMENT ON COLUMN client_api_keys.key_prefix IS 'First 8-10 characters of key for identification';
COMMENT ON COLUMN client_api_keys.key_name IS 'Human-readable name for the API key';
COMMENT ON COLUMN client_api_keys.is_active IS 'Whether the key is currently active and can be used';
COMMENT ON COLUMN client_api_keys.last_used_at IS 'Timestamp of last successful authentication';
COMMENT ON COLUMN client_api_keys.usage_count IS 'Number of times this key has been used';
COMMENT ON COLUMN client_api_keys.revoked_at IS 'Timestamp when key was revoked';
COMMENT ON COLUMN client_api_keys.revoke_reason IS 'Reason for revoking the key';