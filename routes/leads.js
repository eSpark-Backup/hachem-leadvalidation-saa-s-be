// routes/leads.js
import { Router } from 'express';
import { leadQueue } from '#config/queue';
import { uploadToS3 } from '#config/s3';
import { db } from '#config';
import { authenticate, authorize } from '#middleware';
import upload from '#config/multer';
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
 *                 description: JSON file containing leads data
 *               client_id:
 *                 type: string
 *                 description: Unique identifier for the target client
 *                 example: "123"
 *               threshold:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 100
 *                 default: 70
 *                 description: Minimum score threshold for lead acceptance (0-100)
 *                 example: 80
 *     responses:
 *       202:
 *         description: File uploaded successfully and queued for processing
 *       400:
 *         description: Bad request - Invalid file, missing fields, or invalid JSON
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
 *       403:
 *         description: Forbidden - Supplier not authorized for this client
 *       413:
 *         description: File too large
 *       415:
 *         description: Unsupported media type
 *       500:
 *         description: Internal server error
 */
router.post('/upload', authenticate, authorize(['supplier']), upload.single('file'), async (req, res) => {
    try {
        const { client_id, threshold } = req.body;
        const supplierId = req.user.id;

        // Validate required fields
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'File is required'
            });
        }

        if (!client_id) {
            return res.status(400).json({
                success: false,
                message: 'client_id is required'
            });
        }

        // Validate threshold
        const thresholdValue = threshold ? parseInt(threshold) : 70;
        if (isNaN(thresholdValue) || thresholdValue < 0 || thresholdValue > 100) {
            return res.status(400).json({
                success: false,
                message: 'Threshold must be a number between 0 and 100'
            });
        }

        // Validate JSON file content
        try {
            const fileContent = fs.readFileSync(req.file.path, 'utf8');
            const jsonData = JSON.parse(fileContent);

            // Validate JSON structure
            let leads;
            if (Array.isArray(jsonData)) {
                leads = jsonData;
            } else if (jsonData.leads && Array.isArray(jsonData.leads)) {
                leads = jsonData.leads;
            } else {
                throw new Error('Invalid JSON structure');
            }

            if (leads.length === 0) {
                throw new Error('No leads found in file');
            }

        } catch (error) {
            // Clean up uploaded file
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                success: false,
                message: 'Invalid JSON file',
                errors: [error.message]
            });
        }

        const filePath = req.file.path;
        const s3Key = `leads/${Date.now()}-${req.file.originalname}`;

        // Upload to S3
        await uploadToS3(filePath, s3Key);

        // Clean up local file
        fs.unlinkSync(filePath);

        // Insert upload record with supplier_id
        const { rows } = await db.query(
            `INSERT INTO lead_uploads (client_id, supplier_id, s3_key, threshold, status)
             VALUES ($1, $2, $3, $4, 'queued') RETURNING id`,
            [client_id, supplierId, s3Key, thresholdValue]
        );

        const uploadId = rows[0].id;

        // Queue for processing
        await leadQueue.add('processLeads', {
            uploadId,
            s3Key,
            clientId: parseInt(client_id),
            supplierId,
            threshold: thresholdValue,
        });

        res.status(202).json({
            success: true,
            message: 'Upload received and queued',
            data: {
                upload_id: uploadId.toString(),
                status: 'queued'
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
 *     responses:
 *       200:
 *         description: Uploads retrieved successfully
 *       401:
 *         description: Unauthorized
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
 *
 *       **Lead Scoring System (0-100 points):**
 *       - All required fields present: +20 points
 *       - Valid phone format: +30 points
 *       - Not a duplicate: +20 points
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
 *         name: status
 *         schema:
 *           type: string
 *           enum: [valid, invalid, duplicate, below_threshold]
 *         description: Filter results by lead processing status
 *     responses:
 *       200:
 *         description: Processing results retrieved successfully
 *       400:
 *         description: Processing not yet completed
 *       401:
 *         description: Unauthorized
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
 *         name: status
 *         schema:
 *           type: string
 *           enum: [valid, invalid, duplicate, below_threshold]
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
 *       404:
 *         description: Upload not found or access denied
 *       500:
 *         description: Internal server error
 */
router.get('/download-results/:uploadId', authenticate, authorize(['supplier']), leadUploadController.downloadProcessedResults);

export default router;