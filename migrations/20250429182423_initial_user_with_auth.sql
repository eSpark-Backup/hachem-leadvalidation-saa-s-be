-- Migration: initial_user_with_auth
-- Created at: 2025-04-29T18:24:23.691Z

-- Write your SQL here

CREATE TABLE users
(
    id                           SERIAL PRIMARY KEY,
    fullname                     VARCHAR(255) NOT NULL,
    email                        VARCHAR(255) NOT NULL UNIQUE,
    password_hash                VARCHAR(255),
    company                      VARCHAR(255),
    role                         VARCHAR(50)  NOT NULL CHECK (role IN ('client', 'supplier')),
    google_id                    VARCHAR(255) UNIQUE,
    is_verified                  BOOLEAN               DEFAULT FALSE,
    is_active                    BOOLEAN               DEFAULT TRUE,
    verification_code            VARCHAR(10),
    verification_code_expires_at TIMESTAMP,
    reset_token                  VARCHAR(255),
    reset_token_expires_at       TIMESTAMP,
    created_at                   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_google_id ON users (google_id);

-- Down migration:
-- DROP TABLE users;

-- migrations/20250429120001_create_refresh_tokens_table.sql
-- Migration: Create refresh tokens table

CREATE TABLE refresh_tokens
(
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token       VARCHAR(255) NOT NULL UNIQUE,
    expires_at  TIMESTAMP    NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_info JSONB,
    ip_address  VARCHAR(45)
);

-- Create indexes
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens (token);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id);

-- Down migration:
-- DROP TABLE refresh_tokens;

-- migrations/20250429120002_add_updated_at_trigger.sql
-- Migration: Add updated_at trigger to automatically update timestamps

-- Create a function that updates the updated_at timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
    RETURNS TRIGGER AS
$$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger on the users table
CREATE TRIGGER users_update_timestamp
    BEFORE UPDATE
    ON users
    FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Create a trigger on the refresh_tokens table
CREATE TRIGGER refresh_tokens_update_timestamp
    BEFORE UPDATE
    ON refresh_tokens
    FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Down migration:
-- DROP TRIGGER users_update_timestamp ON users;
-- DROP TRIGGER refresh_tokens_update_timestamp ON refresh_tokens;
-- DROP FUNCTION update_timestamp();