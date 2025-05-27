-- Migration: fix_lead_uploads_schema
-- Created at: 2025-05-27T15:15:00.000Z

-- Add missing threshold column if it doesn't exist
-- (This column should already exist based on the schema, but adding IF NOT EXISTS for safety)
ALTER TABLE lead_uploads
    ADD COLUMN IF NOT EXISTS threshold INTEGER DEFAULT 70
        CHECK (threshold >= 0 AND threshold <= 100);

-- Add comment for threshold column
COMMENT ON COLUMN lead_uploads.threshold IS 'Minimum score threshold for lead acceptance (0-100)';

-- Update existing records to have a default threshold if they don't have one
UPDATE lead_uploads
SET threshold = 70
WHERE threshold IS NULL;

-- The schema appears to be correct based on the paste.txt file
-- The issue was in the code trying to reference 'leads_above_threshold' instead of 'valid_leads'
-- No additional schema changes needed as the required columns already exist:
-- - valid_leads (tracks leads that passed validation and are above threshold)
-- - total_leads (tracks total leads in upload)
-- - processed_leads (tracks leads processed so far)
-- - threshold (tracks the threshold used for this upload)