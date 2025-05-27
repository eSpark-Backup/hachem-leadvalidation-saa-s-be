-- Migration: Add supplier tracking to uploads and leads
-- Created at: 2025-05-25T23:32:32.668Z

-- Write your SQL here

-- Add supplier_id and status tracking to lead_uploads table
ALTER TABLE lead_uploads
    ADD COLUMN supplier_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ADD COLUMN status VARCHAR(20) DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    ADD COLUMN total_leads INTEGER DEFAULT 0,
    ADD COLUMN processed_leads INTEGER DEFAULT 0,
    ADD COLUMN valid_leads INTEGER DEFAULT 0,
    ADD COLUMN error_message TEXT,
    ADD COLUMN completed_at TIMESTAMP;

-- Add upload_id to leads table to track which upload each lead came from
ALTER TABLE leads
    ADD COLUMN upload_id INTEGER REFERENCES lead_uploads(id) ON DELETE CASCADE;

-- Create indexes for better performance
CREATE INDEX idx_lead_uploads_supplier_id ON lead_uploads(supplier_id);
CREATE INDEX idx_lead_uploads_status ON lead_uploads(status);
CREATE INDEX idx_leads_upload_id ON leads(upload_id);

-- Add index for faster duplicate checking
CREATE INDEX idx_leads_duplicate_check ON leads(client_id, email, phone, type, created_at);

-- Update existing data (if any) - set a default supplier_id of 1 or NULL
-- UPDATE lead_uploads SET supplier_id = 1 WHERE supplier_id IS NULL;

-- Add comments for documentation
COMMENT ON COLUMN lead_uploads.supplier_id IS 'ID of the supplier who uploaded the leads';
COMMENT ON COLUMN lead_uploads.status IS 'Processing status: queued, processing, completed, failed';
COMMENT ON COLUMN lead_uploads.total_leads IS 'Total number of leads in the uploaded file';
COMMENT ON COLUMN lead_uploads.processed_leads IS 'Number of leads processed so far';
COMMENT ON COLUMN lead_uploads.valid_leads IS 'Number of leads that passed validation';
COMMENT ON COLUMN lead_uploads.error_message IS 'Error message if processing failed';
COMMENT ON COLUMN lead_uploads.completed_at IS 'Timestamp when processing completed';
COMMENT ON COLUMN leads.upload_id IS 'ID of the upload batch this lead belongs to';