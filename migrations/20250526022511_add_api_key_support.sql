-- Migration: Add API keys for supplier lead upload authentication
-- Created at: 2025-05-26T14:00:00.000Z

-- Create api_keys table for supplier authentication
CREATE TABLE api_keys
(
    id            SERIAL PRIMARY KEY,
    supplier_id   INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key_name      VARCHAR(255) NOT NULL,
    api_key       VARCHAR(512)  NOT NULL UNIQUE,
    key_prefix    VARCHAR(100)  NOT NULL,
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
CREATE INDEX idx_api_keys_supplier_id ON api_keys (supplier_id);
CREATE INDEX idx_api_keys_api_key ON api_keys (api_key);
CREATE INDEX idx_api_keys_active ON api_keys (is_active);
CREATE INDEX idx_api_keys_prefix ON api_keys (key_prefix);

-- Add unique constraint on supplier_id + key_name to prevent duplicate names
CREATE UNIQUE INDEX idx_api_keys_supplier_name ON api_keys (supplier_id, key_name) WHERE is_active = true;

-- Comments for documentation
COMMENT ON TABLE api_keys IS 'API keys for supplier authentication during lead uploads';
COMMENT ON COLUMN api_keys.api_key IS 'Full API key (64 characters) - should be hashed in production';
COMMENT ON COLUMN api_keys.key_prefix IS 'First 8-10 characters of key for identification';
COMMENT ON COLUMN api_keys.key_name IS 'Human-readable name for the API key';
COMMENT ON COLUMN api_keys.is_active IS 'Whether the key is currently active and can be used';
COMMENT ON COLUMN api_keys.last_used_at IS 'Timestamp of last successful authentication';
COMMENT ON COLUMN api_keys.usage_count IS 'Number of times this key has been used';
COMMENT ON COLUMN api_keys.revoked_at IS 'Timestamp when key was revoked';
COMMENT ON COLUMN api_keys.revoke_reason IS 'Reason for revoking the key';