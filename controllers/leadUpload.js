// controllers/leadUploadController.js
import { db } from '#config';
import { logger } from '#utils';
import { downloadFromS3 } from '#config/s3';
import fs from 'fs';
import path from 'path';

/**
 * @desc    Get processing status for a specific upload
 * @route   GET /api/leads/status/:uploadId
 * @access  Private (Supplier only)
 */
export const getUploadStatus = async (req, res) => {
    try {
        const { uploadId } = req.params;
        const supplierId = req.user.id;

        // Validate upload ID
        if (!uploadId || isNaN(uploadId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid upload ID'
            });
        }

        // Get upload details - ensure supplier owns this upload
        const uploadQuery = `
            SELECT
                lu.id,
                lu.client_id,
                lu.s3_key,
                lu.threshold,
                lu.uploaded_at,
                lu.status,
                lu.total_leads,
                lu.processed_leads,
                lu.valid_leads,
                lu.error_message,
                lu.completed_at,
                u.fullname as client_name
            FROM lead_uploads lu
                     LEFT JOIN users u ON u.id = lu.client_id
            WHERE lu.id = $1 AND lu.supplier_id = $2
        `;

        const { rows } = await db.query(uploadQuery, [uploadId, supplierId]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Upload not found or access denied'
            });
        }

        const upload = rows[0];

        return res.status(200).json({
            success: true,
            data: {
                upload_id: upload.id.toString(),
                client_id: upload.client_id.toString(),
                client_name: upload.client_name,
                s3_key: upload.s3_key,
                threshold: upload.threshold,
                status: upload.status || 'queued',
                uploaded_at: upload.uploaded_at,
                completed_at: upload.completed_at,
                total_leads: upload.total_leads || 0,
                processed_leads: upload.processed_leads || 0,
                valid_leads: upload.valid_leads || 0,
                error_message: upload.error_message
            }
        });

    } catch (error) {
        logger.error('Get upload status error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while retrieving upload status'
        });
    }
};

/**
 * @desc    Get detailed processing results for an upload
 * @route   GET /api/leads/results/:uploadId
 * @access  Private (Supplier only)
 */
export const getUploadResults = async (req, res) => {
    try {
        const { uploadId } = req.params;
        const supplierId = req.user.id;
        const { page = 1, limit = 50, status: filterStatus } = req.query;

        // Validate parameters
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset = (pageNum - 1) * limitNum;

        // Verify upload exists and belongs to supplier
        const uploadQuery = `
            SELECT id, status, total_leads, valid_leads
            FROM lead_uploads
            WHERE id = $1 AND supplier_id = $2
        `;

        const { rows: uploadRows } = await db.query(uploadQuery, [uploadId, supplierId]);

        if (uploadRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Upload not found or access denied'
            });
        }

        const upload = uploadRows[0];

        if (upload.status !== 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Processing not yet completed. Check status first.'
            });
        }

        // Build query for lead results - removed unused supplierId parameter
        let resultsQuery = `
            SELECT
                l.id as lead_id,
                l.email,
                l.phone,
                l.address,
                l.type,
                l.score,
                l.other_fields,
                l.created_at,
                CASE
                    WHEN l.score >= $2 THEN 'valid'
                    WHEN l.score = 0 THEN 'duplicate'
                    WHEN l.score < $2 THEN 'below_threshold'
                    ELSE 'invalid'
                    END as processing_status,
                CASE WHEN l.score >= $2 THEN true ELSE false END as forwarded
            FROM leads l
            WHERE l.upload_id = $1
        `;

        const queryParams = [uploadId, upload.threshold || 70];
        let paramCounter = 3;

        // Add status filter if provided
        if (filterStatus && ['valid', 'invalid', 'duplicate', 'below_threshold'].includes(filterStatus)) {
            if (filterStatus === 'valid') {
                resultsQuery += ` AND l.score >= ${paramCounter}`;
                queryParams.push(upload.threshold || 70);
                paramCounter++;
            } else if (filterStatus === 'duplicate') {
                resultsQuery += ` AND l.score = 0`;
            } else if (filterStatus === 'below_threshold') {
                resultsQuery += ` AND l.score > 0 AND l.score < ${paramCounter}`;
                queryParams.push(upload.threshold || 70);
                paramCounter++;
            } else if (filterStatus === 'invalid') {
                resultsQuery += ` AND l.score IS NULL`;
            }
        }

        // Add pagination
        resultsQuery += ` ORDER BY l.created_at DESC LIMIT $${paramCounter} OFFSET $${paramCounter + 1}`;
        queryParams.push(limitNum, offset);

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) as total
            FROM leads l
            WHERE l.upload_id = $1
        `;

        const [resultsResponse, countResponse] = await Promise.all([
            db.query(resultsQuery, queryParams),
            db.query(countQuery, [uploadId])
        ]);

        const results = resultsResponse.rows;
        const totalResults = parseInt(countResponse.rows[0].total);
        const totalPages = Math.ceil(totalResults / limitNum);

        // Calculate summary statistics
        const summaryQuery = `
            SELECT
                COUNT(*) as total_submitted,
                SUM(CASE WHEN score >= $2 THEN 1 ELSE 0 END) as valid,
                SUM(CASE WHEN score IS NULL THEN 1 ELSE 0 END) as invalid,
                SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) as duplicates,
                SUM(CASE WHEN score > 0 AND score < $2 THEN 1 ELSE 0 END) as below_threshold,
                SUM(CASE WHEN score >= $2 THEN 1 ELSE 0 END) as forwarded_to_client
            FROM leads
            WHERE upload_id = $1
        `;

        const { rows: summaryRows } = await db.query(summaryQuery, [uploadId, upload.threshold || 70]);
        const summary = summaryRows[0];

        // Format results
        const formattedResults = results.map(result => ({
            lead_id: result.lead_id.toString(),
            status: result.processing_status,
            score: result.score || 0,
            forwarded: result.forwarded,
            errors: result.score === null ? ['Failed validation'] : [],
            warnings: [],
            original_data: {
                phone: result.phone,
                email: result.email,
                address: result.address,
                type: result.type,
                ...result.other_fields
            }
        }));

        return res.status(200).json({
            success: true,
            data: {
                upload_id: uploadId,
                summary: {
                    total_submitted: parseInt(summary.total_submitted),
                    valid: parseInt(summary.valid),
                    invalid: parseInt(summary.invalid),
                    duplicates: parseInt(summary.duplicates),
                    below_threshold: parseInt(summary.below_threshold),
                    forwarded_to_client: parseInt(summary.forwarded_to_client)
                },
                results: formattedResults,
                pagination: {
                    current_page: pageNum,
                    total_pages: totalPages,
                    total_results: totalResults,
                    per_page: limitNum
                }
            }
        });

    } catch (error) {
        logger.error('Get upload results error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while retrieving upload results'
        });
    }
};

/**
 * @desc    Download original uploaded file
 * @route   GET /api/leads/download/:uploadId
 * @access  Private (Supplier only)
 */
export const downloadUploadedFile = async (req, res) => {
    try {
        const { uploadId } = req.params;
        const supplierId = req.user.id;

        // Verify upload exists and belongs to supplier
        const uploadQuery = `
            SELECT s3_key, uploaded_at
            FROM lead_uploads
            WHERE id = $1 AND supplier_id = $2
        `;

        const { rows } = await db.query(uploadQuery, [uploadId, supplierId]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Upload not found or access denied'
            });
        }

        const { s3_key, uploaded_at } = rows[0];

        // Download file from S3
        const fileContent = await downloadFromS3(s3_key);

        // Generate filename
        const uploadDate = new Date(uploaded_at).toISOString().split('T')[0];
        const filename = `leads_upload_${uploadId}_${uploadDate}.json`;

        // Set response headers
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', Buffer.byteLength(fileContent));

        return res.status(200).send(fileContent);

    } catch (error) {
        logger.error('Download uploaded file error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while downloading file'
        });
    }
};

/**
 * @desc    Download processed leads (results)
 * @route   GET /api/leads/download-results/:uploadId
 * @access  Private (Supplier only)
 */
export const downloadProcessedResults = async (req, res) => {
    try {
        const { uploadId } = req.params;
        const supplierId = req.user.id;
        const { format = 'json', status: filterStatus } = req.query;

        // Verify upload exists and belongs to supplier
        const uploadQuery = `
            SELECT id, status, threshold
            FROM lead_uploads
            WHERE id = $1 AND supplier_id = $2
        `;

        const { rows: uploadRows } = await db.query(uploadQuery, [uploadId, supplierId]);

        if (uploadRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Upload not found or access denied'
            });
        }

        const upload = uploadRows[0];

        if (upload.status !== 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Processing not yet completed'
            });
        }

        // Get processed results - fixed parameter numbering
        let resultsQuery = `
            SELECT
                l.id as lead_id,
                l.email,
                l.phone,
                l.address,
                l.type,
                l.score,
                l.other_fields,
                l.created_at,
                CASE
                    WHEN l.score >= $2 THEN 'valid'
                    WHEN l.score = 0 THEN 'duplicate'
                    WHEN l.score < $2 THEN 'below_threshold'
                    ELSE 'invalid'
                    END as processing_status,
                CASE WHEN l.score >= $2 THEN true ELSE false END as forwarded
            FROM leads l
            WHERE l.upload_id = $1
        `;

        const queryParams = [uploadId, upload.threshold || 70];

        // Add status filter if provided
        if (filterStatus && ['valid', 'invalid', 'duplicate', 'below_threshold'].includes(filterStatus)) {
            if (filterStatus === 'valid') {
                resultsQuery += ` AND l.score >= $2`;
            } else if (filterStatus === 'duplicate') {
                resultsQuery += ` AND l.score = 0`;
            } else if (filterStatus === 'below_threshold') {
                resultsQuery += ` AND l.score > 0 AND l.score < $2`;
            } else if (filterStatus === 'invalid') {
                resultsQuery += ` AND l.score IS NULL`;
            }
        }

        resultsQuery += ` ORDER BY l.created_at DESC`;

        const { rows: results } = await db.query(resultsQuery, queryParams);

        // Format results
        const formattedResults = results.map(result => ({
            lead_id: result.lead_id.toString(),
            status: result.processing_status,
            score: result.score || 0,
            forwarded: result.forwarded,
            original_data: {
                phone: result.phone,
                email: result.email,
                address: result.address,
                type: result.type,
                ...result.other_fields
            },
            processed_at: result.created_at
        }));

        const filename = `processed_leads_${uploadId}_${new Date().toISOString().split('T')[0]}`;

        if (format === 'csv') {
            // Convert to CSV format
            const csvHeaders = ['lead_id', 'status', 'score', 'forwarded', 'phone', 'email', 'address', 'type', 'processed_at'];
            const csvRows = formattedResults.map(result => [
                result.lead_id,
                result.status,
                result.score,
                result.forwarded,
                result.original_data.phone,
                result.original_data.email,
                result.original_data.address,
                result.original_data.type,
                result.processed_at
            ]);

            const csvContent = [csvHeaders, ...csvRows]
                .map(row => row.map(field => `"${field}"`).join(','))
                .join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
            return res.status(200).send(csvContent);
        } else {
            // Default JSON format
            const jsonContent = JSON.stringify({
                upload_id: uploadId,
                processed_at: new Date().toISOString(),
                total_results: formattedResults.length,
                results: formattedResults
            }, null, 2);

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
            return res.status(200).send(jsonContent);
        }

    } catch (error) {
        logger.error('Download processed results error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while downloading results'
        });
    }
};

/**
 * @desc    Get all uploads for the supplier
 * @route   GET /api/leads/uploads
 * @access  Private (Supplier only)
 */
export const getSupplierUploads = async (req, res) => {
    try {
        const supplierId = req.user.id;
        const { page = 1, limit = 20, status } = req.query;

        // Validate parameters
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset = (pageNum - 1) * limitNum;

        // Build query
        let uploadsQuery = `
            SELECT
                lu.id,
                lu.client_id,
                lu.s3_key,
                lu.threshold,
                lu.uploaded_at,
                lu.status,
                lu.total_leads,
                lu.processed_leads,
                lu.valid_leads,
                lu.error_message,
                lu.completed_at,
                u.fullname as client_name
            FROM lead_uploads lu
                     LEFT JOIN users u ON u.id = lu.client_id
            WHERE lu.supplier_id = $1
        `;

        const queryParams = [supplierId];
        let paramCounter = 2;

        // Add status filter if provided
        if (status && ['queued', 'processing', 'completed', 'failed'].includes(status)) {
            uploadsQuery += ` AND lu.status = $${paramCounter}`;
            queryParams.push(status);
            paramCounter++;
        }

        // Add pagination
        uploadsQuery += ` ORDER BY lu.uploaded_at DESC LIMIT $${paramCounter} OFFSET $${paramCounter + 1}`;
        queryParams.push(limitNum, offset);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM lead_uploads
            WHERE supplier_id = $1
                ${status ? 'AND status = $2' : ''}
        `;

        const countParams = status ? [supplierId, status] : [supplierId];

        const [uploadsResponse, countResponse] = await Promise.all([
            db.query(uploadsQuery, queryParams),
            db.query(countQuery, countParams)
        ]);

        const uploads = uploadsResponse.rows;
        const totalUploads = parseInt(countResponse.rows[0].total);
        const totalPages = Math.ceil(totalUploads / limitNum);

        const formattedUploads = uploads.map(upload => ({
            upload_id: upload.id.toString(),
            client_id: upload.client_id.toString(),
            client_name: upload.client_name,
            threshold: upload.threshold,
            status: upload.status || 'queued',
            uploaded_at: upload.uploaded_at,
            completed_at: upload.completed_at,
            total_leads: upload.total_leads || 0,
            processed_leads: upload.processed_leads || 0,
            valid_leads: upload.valid_leads || 0,
            error_message: upload.error_message
        }));

        return res.status(200).json({
            success: true,
            data: {
                uploads: formattedUploads,
                pagination: {
                    current_page: pageNum,
                    total_pages: totalPages,
                    total_uploads: totalUploads,
                    per_page: limitNum
                }
            }
        });

    } catch (error) {
        logger.error('Get supplier uploads error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while retrieving uploads'
        });
    }
};

export default {
    getUploadStatus,
    getUploadResults,
    downloadUploadedFile,
    downloadProcessedResults,
    getSupplierUploads
};