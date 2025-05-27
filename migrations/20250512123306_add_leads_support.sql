-- Migration: add_leads_support
-- Created at: 2025-05-12T12:33:06.583Z

-- Write your SQL here

-- Active leads
CREATE TABLE leads
(
    id            SERIAL PRIMARY KEY,
    client_id     INT  NOT NULL,
    email         TEXT NOT NULL,
    phone         TEXT NOT NULL,
    address       TEXT,
    type          TEXT,
    score         INT,
    other_fields  JSONB     DEFAULT '{}',
    created_at    TIMESTAMP DEFAULT NOW(),
    client_status TEXT      DEFAULT NULL
);

-- Archived leads
CREATE TABLE leads_archive
(
    id                  SERIAL PRIMARY KEY,
    client_id           INT,
    email               TEXT,
    phone               TEXT,
    address             TEXT,
    type                TEXT,
    score               INT,
    other_fields        JSONB DEFAULT '{}',
    original_created_at TIMESTAMP
);

-- Uploads metadata
CREATE TABLE lead_uploads
(
    id          SERIAL PRIMARY KEY,
    client_id   INT  NOT NULL,
    s3_key      TEXT NOT NULL,
    threshold   INT       DEFAULT 70,
    uploaded_at TIMESTAMP DEFAULT NOW()
);

