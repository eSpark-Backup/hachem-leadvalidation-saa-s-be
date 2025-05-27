// routes/leads.js - Updated with proper Swagger documentation
import { Router } from 'express';
import { leadQueue } from '#config/queue';
import { uploadToS3 } from '#config/s3';
import { db } from '#config';
import { authenticate, authorize } from '#middleware';
import { authenticateApiKey, requireSupplierRole, rateLimitApiKey } from '#middleware/apiKeyAuth';
import upload, { handleMulterError } from '#config/multer';
import * as leadUploadController from '#controllers/leadUpload';
import fs from 'fs';

const router = Router();

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     supplierBearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: JWT Bearer token for supplier authentication (dashboard access)
 *     clientBearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: JWT Bearer token for client authentication (dashboard access)
 *     supplierApiKey:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: API Key
 *       description: |
 *         Supplier API Key for programmatic access.
 *         Format: Bearer sk_your_api_key_here
 *         Example: Bearer sk_1234567890abcdef
 */

/**
 * @swagger
 * /api/leads/upload:
 *   post:
 *     summary: Upload JSON file containing leads for validation
 *     description: |
 *       Upload a JSON file containing leads for validation and certification.
 *       The file is uploaded to S3 and queued for background processing.
 *
 *       **AUTHENTICATION**: This endpoint uses API key authentication instead of JWT tokens.
 *       Use your supplier API key in the Authorization header: `Bearer sk_your_api_key_here`
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
 *       - supplierApiKey: []
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
 *                     client_name:
 *                       type: string
 *                       example: "John Smith"
 *                     total_leads:
 *                       type: integer
 *                       example: 150
 *                     api_key_used:
 *                       type: string
 *                       example: "Production API Key"
 *       400:
 *         description: Bad request - Invalid file, missing fields, or invalid JSON
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "File is required"
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["No file uploaded"]
 *       401:
 *         description: Unauthorized - Invalid or missing API key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Invalid or missing API key"
 *       413:
 *         description: File too large
 *       415:
 *         description: Unsupported media type
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.post('/upload',
    authenticateApiKey,           // Use API key auth instead of JWT
    requireSupplierRole,          // Ensure supplier role
    rateLimitApiKey(100, 60000),  // Rate limit: 100 requests per minute
    upload.single('file'),
    async (req, res) => {
        try {
            const { client_id } = req.body;
            const supplierId = req.user.id;

            // Log upload attempt for monitoring
            console.log(`Lead upload attempt by supplier ${supplierId} using API key ${req.user.keyName}`);

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

            // Insert upload record
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
                    total_leads: leads.length,
                    api_key_used: req.user.keyName // Show which key was used
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
 *       Uses JWT authentication for dashboard access.
 *     tags:
 *       - Leads
 *     security:
 *       - supplierBearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *         example: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of uploads per page
 *         example: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [queued, processing, completed, failed]
 *         description: Filter uploads by status
 *         example: completed
 *     responses:
 *       200:
 *         description: Uploads retrieved successfully
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
 *                     uploads:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           upload_id:
 *                             type: string
 *                             example: "123"
 *                           client_id:
 *                             type: string
 *                             example: "456"
 *                           client_name:
 *                             type: string
 *                             example: "John Smith"
 *                           threshold:
 *                             type: integer
 *                             example: 70
 *                           status:
 *                             type: string
 *                             example: "completed"
 *                           uploaded_at:
 *                             type: string
 *                             format: date-time
 *                           total_leads:
 *                             type: integer
 *                             example: 150
 *                           valid_leads:
 *                             type: integer
 *                             example: 120
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         current_page:
 *                           type: integer
 *                           example: 1
 *                         total_pages:
 *                           type: integer
 *                           example: 5
 *                         total_uploads:
 *                           type: integer
 *                           example: 100
 *       401:
 *         description: Unauthorized - Invalid JWT token
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
 *       Uses JWT authentication for dashboard access.
 *     tags:
 *       - Leads
 *     security:
 *       - supplierBearerAuth: []
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
 *                     upload_id:
 *                       type: string
 *                       example: "12345"
 *                     client_id:
 *                       type: string
 *                       example: "123"
 *                     client_name:
 *                       type: string
 *                       example: "John Smith"
 *                     status:
 *                       type: string
 *                       enum: [queued, processing, completed, failed]
 *                       example: "completed"
 *                     total_leads:
 *                       type: integer
 *                       example: 150
 *                     processed_leads:
 *                       type: integer
 *                       example: 150
 *                     valid_leads:
 *                       type: integer
 *                       example: 120
 *                     uploaded_at:
 *                       type: string
 *                       format: date-time
 *                     completed_at:
 *                       type: string
 *                       format: date-time
 *                     error_message:
 *                       type: string
 *                       nullable: true
 *       401:
 *         description: Unauthorized - Invalid JWT token
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
 *       Uses JWT authentication for dashboard access.
 *
 *       **Lead Scoring System (0-100 points):**
 *       - All required fields present: +20 points
 *       - Valid phone format: +30 points
 *       - Not a duplicate: +20 points
 *       - Passes type-specific validation: +30 points
 *     tags:
 *       - Leads
 *     security:
 *       - supplierBearerAuth: []
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
 *         example: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of results per page
 *         example: 50
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [valid, invalid, duplicate, below_threshold]
 *         description: Filter results by lead processing status
 *         example: valid
 *     responses:
 *       200:
 *         description: Processing results retrieved successfully
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
 *                     upload_id:
 *                       type: string
 *                       example: "12345"
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_submitted:
 *                           type: integer
 *                           example: 150
 *                         valid:
 *                           type: integer
 *                           example: 120
 *                         invalid:
 *                           type: integer
 *                           example: 15
 *                         duplicates:
 *                           type: integer
 *                           example: 10
 *                         below_threshold:
 *                           type: integer
 *                           example: 5
 *                         forwarded_to_client:
 *                           type: integer
 *                           example: 85
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           lead_id:
 *                             type: string
 *                             example: "lead_001"
 *                           status:
 *                             type: string
 *                             enum: [valid, invalid, duplicate, below_threshold]
 *                             example: "valid"
 *                           score:
 *                             type: integer
 *                             minimum: 0
 *                             maximum: 100
 *                             example: 85
 *                           forwarded:
 *                             type: boolean
 *                             example: true
 *                           errors:
 *                             type: array
 *                             items:
 *                               type: string
 *                             example: []
 *                           warnings:
 *                             type: array
 *                             items:
 *                               type: string
 *                             example: []
 *                           original_data:
 *                             type: object
 *                             example:
 *                               phone: "+33123456789"
 *                               email: "john@example.com"
 *                               address: "123 Main St, Paris, 75001"
 *                               type: "solar_panel"
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         current_page:
 *                           type: integer
 *                           example: 1
 *                         total_pages:
 *                           type: integer
 *                           example: 3
 *                         total_results:
 *                           type: integer
 *                           example: 150
 *                         per_page:
 *                           type: integer
 *                           example: 50
 *       400:
 *         description: Processing not yet completed
 *       401:
 *         description: Unauthorized - Invalid JWT token
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
 *       Uses JWT authentication for dashboard access.
 *     tags:
 *       - Leads
 *     security:
 *       - supplierBearerAuth: []
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
 *         headers:
 *           Content-Disposition:
 *             description: Attachment filename
 *             schema:
 *               type: string
 *               example: 'attachment; filename="leads_upload_12345_2025-05-27.json"'
 *       401:
 *         description: Unauthorized - Invalid JWT token
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
 *       Uses JWT authentication for dashboard access.
 *     tags:
 *       - Leads
 *     security:
 *       - supplierBearerAuth: []
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
 *         example: json
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [valid, invalid, duplicate, below_threshold]
 *         description: Filter results by lead processing status
 *         example: valid
 *     responses:
 *       200:
 *         description: Results downloaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Processed results in JSON format
 *               properties:
 *                 upload_id:
 *                   type: string
 *                   example: "12345"
 *                 processed_at:
 *                   type: string
 *                   format: date-time
 *                 total_results:
 *                   type: integer
 *                   example: 150
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *           text/csv:
 *             schema:
 *               type: string
 *               description: Processed results in CSV format
 *               example: |
 *                 "lead_id","status","score","forwarded","phone","email","address","type","processed_at"
 *                 "1","valid","95","true","+33123456789","john@example.com","123 Main St","solar_panel","2025-05-27T10:30:00Z"
 *         headers:
 *           Content-Disposition:
 *             description: Attachment filename
 *             schema:
 *               type: string
 *               example: 'attachment; filename="processed_leads_12345_2025-05-27.json"'
 *       400:
 *         description: Processing not yet completed
 *       401:
 *         description: Unauthorized - Invalid JWT token
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
 *       Get comprehensive statistics for the current supplier including success rates,
 *       lead validation metrics, and performance over time.
 *       Uses JWT authentication for dashboard access.
 *     tags:
 *       - Leads
 *     security:
 *       - supplierBearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *           default: 30
 *         description: Number of days to include in statistics
 *         example: 30
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
 *                       description: Total number of uploads in the period
 *                       example: 25
 *                     completed_uploads:
 *                       type: integer
 *                       description: Number of successfully completed uploads
 *                       example: 23
 *                     failed_uploads:
 *                       type: integer
 *                       description: Number of failed uploads
 *                       example: 1
 *                     pending_uploads:
 *                       type: integer
 *                       description: Number of uploads still processing or queued
 *                       example: 1
 *                     total_leads_uploaded:
 *                       type: integer
 *                       description: Total leads uploaded across all uploads
 *                       example: 2500
 *                     total_valid_leads:
 *                       type: integer
 *                       description: Total leads that passed validation
 *                       example: 2100
 *                     success_rate:
 *                       type: number
 *                       format: float
 *                       description: Upload success rate as percentage
 *                       example: 92.0
 *                     valid_lead_rate:
 *                       type: number
 *                       format: float
 *                       description: Lead validation rate as percentage
 *                       example: 84.0
 *                     period_days:
 *                       type: integer
 *                       description: Number of days covered by the statistics
 *                       example: 30
 *       401:
 *         description: Unauthorized - Invalid JWT token
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