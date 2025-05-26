// routes/leads.js - Simplified without authorization logic
import { Router } from 'express';
import { leadQueue } from '#config/queue';
import { uploadToS3 } from '#config/s3';
import { db } from '#config';
import { authenticate, authorize } from '#middleware';
import upload, { handleMulterError } from '#config/multer';
import * as leadUploadController from '#controllers/leadUpload';
import fs from 'fs';

const router = Router();

/**
 * @swagger
 * /api/leads/upload:
 *   post:
 *     summary: Upload JSON file containing leads for validation
 *     description: |
 *       Upload a JSON file containing leads for validation and certification.
 *       The file is uploaded to S3 and queued for background processing.
 *       Processing results will be available via separate status/results endpoints.
 *
 *       **IMPORTANT**: Lead scoring thresholds are set by the CLIENT, not the supplier.
 *       The supplier just uploads leads, and the client's threshold settings determine
 *       which leads they want to receive.
 *
 *       **JSON File Structure:**
 *       - Must be a valid JSON file
 *       - Can contain an array of lead objects directly, or an object with a "leads" property
 *       - Each lead must have required fields: phone, email, address, type
 *
 *       **Lead Types and Requirements:**
 *       - **solar_panel**: requires roof_orientation (should contain "south")
 *       - **insulation**: requires home_age (must be > 15 years)
 *       - **ev_charger**: requires garage or parking (at least one must be true)
 *       - **insurance**: requires zip or city information
 *
 *       **Lead Scoring System (0-100 points):**
 *       - All required fields present: +20 points
 *       - Valid phone format: +30 points
 *       - Not a duplicate (within 30 days): +20 points
 *       - Passes type-specific validation: +30 points
 *     tags:
 *       - Leads
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - client_id
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: |
 *                   JSON file containing leads data.
 *
 *                   **Example JSON structure (array format):**
 *                   ```json
 *                   [
 *                     {
 *                       "phone": "+33123456789",
 *                       "email": "john@example.com",
 *                       "address": "123 Main St, Paris, 75001, France",
 *                       "type": "solar_panel",
 *                       "roof_orientation": "south",
 *                       "first_name": "John",
 *                       "last_name": "Doe"
 *                     }
 *                   ]
 *                   ```
 *
 *                   **Example JSON structure (object format):**
 *                   ```json
 *                   {
 *                     "leads": [
 *                       {
 *                         "phone": "+33123456789",
 *                         "email": "john@example.com",
 *                         "address": "123 Main St, Paris, 75001, France",
 *                         "type": "solar_panel",
 *                         "roof_orientation": "south"
 *                       }
 *                     ]
 *                   }
 *                   ```
 *               client_id:
 *                 type: string
 *                 description: Unique identifier for the target client
 *                 example: "123"
 *     responses:
 *       202:
 *         description: File uploaded successfully and queued for processing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Upload received and queued"
 *                 data:
 *                   type: object
 *                   properties:
 *                     upload_id:
 *                       type: string
 *                       example: "12345"
 *                     status:
 *                       type: string
 *                       example: "queued"
 *       400:
 *         description: Bad request - Invalid file, missing fields, or invalid JSON
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
 *       413:
 *         description: File too large
 *       415:
 *         description: Unsupported media type
 *       500:
 *         description: Internal server error
 */
router.post('/upload', authenticate, authorize(['supplier']), upload.single('file'), async (req, res) => {
    try {
        const { client_id } = req.body;
        const supplierId = req.user.id;

        // Validate required fields
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'File is required',
                errors: ['No file uploaded']
            });
        }

        if (!client_id) {
            return res.status(400).json({
                success: false,
                message: 'client_id is required',
                errors: ['client_id parameter is required']
            });
        }

        // Validate client_id is a number
        const clientIdNum = parseInt(client_id);
        if (isNaN(clientIdNum)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid client_id',
                errors: ['client_id must be a valid number']
            });
        }

        // Check if client exists and is active
        const { rows: clientRows } = await db.query(
            'SELECT id, fullname, is_active FROM users WHERE id = $1 AND role = $2',
            [clientIdNum, 'client']
        );

        if (clientRows.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid client_id',
                errors: ['Client not found']
            });
        }

        if (!clientRows[0].is_active) {
            return res.status(400).json({
                success: false,
                message: 'Client account is inactive',
                errors: ['Cannot upload leads to inactive client']
            });
        }

        // Validate JSON file content
        let leads;
        try {
            const fileContent = fs.readFileSync(req.file.path, 'utf8');
            const jsonData = JSON.parse(fileContent);

            // Validate JSON structure
            if (Array.isArray(jsonData)) {
                leads = jsonData;
            } else if (jsonData.leads && Array.isArray(jsonData.leads)) {
                leads = jsonData.leads;
            } else {
                throw new Error('JSON must contain an array of leads or an object with "leads" property');
            }

            if (leads.length === 0) {
                throw new Error('No leads found in the uploaded file');
            }

            // Basic validation of leads structure
            const requiredFields = ['phone', 'email', 'address', 'type'];
            for (let i = 0; i < Math.min(leads.length, 10); i++) { // Check first 10 leads
                const lead = leads[i];
                for (const field of requiredFields) {
                    if (!lead[field] || typeof lead[field] !== 'string' || lead[field].trim() === '') {
                        throw new Error(`Lead ${i + 1} is missing required field: ${field}`);
                    }
                }
            }

        } catch (error) {
            // Clean up uploaded file
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(400).json({
                success: false,
                message: 'Invalid JSON file',
                errors: [error.message]
            });
        }

        const filePath = req.file.path;
        const s3Key = `leads/${Date.now()}-${req.file.originalname}`;

        // Upload to S3 (or local storage)
        try {
            await uploadToS3(filePath, s3Key);
        } catch (uploadError) {
            // Clean up local file
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            throw new Error(`Failed to upload file to storage: ${uploadError.message}`);
        }

        // Clean up local file after successful upload
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Insert upload record (no threshold - it comes from client settings)
        const { rows } = await db.query(
            `INSERT INTO lead_uploads (client_id, supplier_id, s3_key, status, total_leads)
             VALUES ($1, $2, $3, 'queued', $4) RETURNING id`,
            [clientIdNum, supplierId, s3Key, leads.length]
        );

        const uploadId = rows[0].id;

        // Queue for processing
        await leadQueue.add('processLeads', {
            uploadId,
            s3Key,
            clientId: clientIdNum,
            supplierId
        }, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000,
            },
            removeOnComplete: 10,
            removeOnFail: 20
        });

        res.status(202).json({
            success: true,
            message: 'Upload received and queued',
            data: {
                upload_id: uploadId.toString(),
                status: 'queued',
                client_name: clientRows[0].fullname,
                total_leads: leads.length
            }
        });

    } catch (error) {
        console.error('Upload error:', error);

        // Clean up file if it exists
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            success: false,
            message: 'Internal server error occurred while processing upload'
        });
    }
});

// Add multer error handling middleware
router.use(handleMulterError);

/**
 * @swagger
 * /api/leads/uploads:
 *   get:
 *     summary: Get all uploads for the current supplier
 *     description: |
 *       Retrieve a paginated list of all uploads made by the current supplier.
 *       Includes status, processing information, and client details.
 *     tags:
 *       - Leads
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of uploads per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [queued, processing, completed, failed]
 *         description: Filter uploads by status
 *       - in: query
 *         name: client_id
 *         schema:
 *           type: integer
 *         description: Filter uploads by specific client
 *     responses:
 *       200:
 *         description: Uploads retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/uploads', authenticate, authorize(['supplier']), leadUploadController.getSupplierUploads);

/**
 * @swagger
 * /api/leads/status/{uploadId}:
 *   get:
 *     summary: Get upload processing status
 *     description: |
 *       Check the processing status of an uploaded JSON file.
 *       Returns current status and progress information.
 *     tags:
 *       - Leads
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uploadId
 *         required: true
 *         schema:
 *           type: string
 *         description: Upload ID from the database record
 *         example: "12345"
 *     responses:
 *       200:
 *         description: Processing status retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       404:
 *         description: Upload not found or access denied
 *       500:
 *         description: Internal server error
 */
router.get('/status/:uploadId', authenticate, authorize(['supplier']), leadUploadController.getUploadStatus);

/**
 * @swagger
 * /api/leads/results/{uploadId}:
 *   get:
 *     summary: Get detailed processing results
 *     description: |
 *       Get comprehensive processing results for a completed upload.
 *       Returns validation statistics and individual lead processing results.
 *       Results show scores for all leads, regardless of client threshold.
 *
 *       **Lead Scoring System (0-100 points):**
 *       - All required fields present: +20 points
 *       - Valid phone format: +30 points
 *       - Not a duplicate (within 30 days): +20 points
 *       - Passes type-specific validation: +30 points
 *     tags:
 *       - Leads
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uploadId
 *         required: true
 *         schema:
 *           type: string
 *         description: Upload ID from the database record
 *         example: "12345"
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination of results
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of results per page
 *       - in: query
 *         name: min_score
 *         schema:
 *           type: integer
 *           minimum: 0
 *           maximum: 100
 *         description: Filter results by minimum score
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [valid, invalid, duplicate]
 *         description: Filter results by lead processing status
 *     responses:
 *       200:
 *         description: Processing results retrieved successfully
 *       400:
 *         description: Processing not yet completed
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       404:
 *         description: Upload not found or access denied
 *       500:
 *         description: Internal server error
 */
router.get('/results/:uploadId', authenticate, authorize(['supplier']), leadUploadController.getUploadResults);

/**
 * @swagger
 * /api/leads/download/{uploadId}:
 *   get:
 *     summary: Download original uploaded file
 *     description: |
 *       Download the original JSON file that was uploaded for processing.
 *       Returns the exact file that was submitted by the supplier.
 *     tags:
 *       - Leads
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uploadId
 *         required: true
 *         schema:
 *           type: string
 *         description: Upload ID from the database record
 *         example: "12345"
 *     responses:
 *       200:
 *         description: File downloaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Original uploaded JSON file content
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       404:
 *         description: Upload not found or access denied
 *       500:
 *         description: Internal server error
 */
router.get('/download/:uploadId', authenticate, authorize(['supplier']), leadUploadController.downloadUploadedFile);

/**
 * @swagger
 * /api/leads/download-results/{uploadId}:
 *   get:
 *     summary: Download processed leads results
 *     description: |
 *       Download the processing results for an upload in JSON or CSV format.
 *       Includes validation scores, status, and original lead data.
 *     tags:
 *       - Leads
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uploadId
 *         required: true
 *         schema:
 *           type: string
 *         description: Upload ID from the database record
 *         example: "12345"
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, csv]
 *           default: json
 *         description: Download format (JSON or CSV)
 *       - in: query
 *         name: min_score
 *         schema:
 *           type: integer
 *           minimum: 0
 *           maximum: 100
 *         description: Filter results by minimum score
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [valid, invalid, duplicate]
 *         description: Filter results by lead processing status
 *     responses:
 *       200:
 *         description: Results downloaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Processed results in JSON format
 *           text/csv:
 *             schema:
 *               type: string
 *               description: Processed results in CSV format
 *       400:
 *         description: Processing not yet completed
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       404:
 *         description: Upload not found or access denied
 *       500:
 *         description: Internal server error
 */
router.get('/download-results/:uploadId', authenticate, authorize(['supplier']), leadUploadController.downloadProcessedResults);

/**
 * @swagger
 * /api/leads/supplier-stats:
 *   get:
 *     summary: Get supplier performance statistics
 *     description: |
 *       Get comprehensive statistics for the current supplier including
 *       upload success rates, lead quality metrics, and performance data.
 *     tags:
 *       - Leads
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *           default: 30
 *         description: Number of days to include in statistics
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_uploads:
 *                       type: integer
 *                       example: 25
 *                     completed_uploads:
 *                       type: integer
 *                       example: 23
 *                     failed_uploads:
 *                       type: integer
 *                       example: 1
 *                     pending_uploads:
 *                       type: integer
 *                       example: 1
 *                     total_leads_uploaded:
 *                       type: integer
 *                       example: 2500
 *                     total_valid_leads:
 *                       type: integer
 *                       example: 2100
 *                     unique_clients:
 *                       type: integer
 *                       example: 5
 *                     success_rate:
 *                       type: number
 *                       example: 92.0
 *                     valid_lead_rate:
 *                       type: number
 *                       example: 84.0
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/supplier-stats', authenticate, authorize(['supplier']), async (req, res) => {
    try {
        const supplierId = req.user.id;
        const days = parseInt(req.query.days) || 30;

        // Import Leads model dynamically to avoid circular dependency
        const { default: Leads } = await import('#models/leads');
        const stats = await Leads.getSupplierStats(supplierId, days);

        // Calculate additional metrics
        const successRate = stats.total_uploads > 0
            ? ((stats.completed_uploads / stats.total_uploads) * 100).toFixed(1)
            : 0;

        const validLeadRate = stats.total_leads_uploaded > 0
            ? ((stats.total_valid_leads / stats.total_leads_uploaded) * 100).toFixed(1)
            : 0;

        res.status(200).json({
            success: true,
            data: {
                ...stats,
                success_rate: parseFloat(successRate),
                valid_lead_rate: parseFloat(validLeadRate),
                period_days: days
            }
        });
    } catch (error) {
        console.error('Get supplier stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving supplier statistics'
        });
    }
});

export default router;