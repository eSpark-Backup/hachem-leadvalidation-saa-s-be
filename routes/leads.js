import {Router} from 'express'
import {leadQueue} from "#config/queue";
import {uploadToS3} from "#config/s3";
import {db} from "#config";

const router = Router()


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
 *       - BearerAuth: []
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
 *               threshold:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 100
 *                 default: 70
 *                 description: Minimum score threshold for lead acceptance (0-100)
 *                 example: 80
 *           encoding:
 *             file:
 *               contentType: application/json
 *           examples:
 *             solar_panel_upload:
 *               summary: Solar panel leads JSON file
 *               value:
 *                 client_id: "123"
 *                 threshold: 75
 *                 file: |
 *                   JSON file containing:
 *                   [
 *                     {
 *                       "phone": "+33123456789",
 *                       "email": "solar1@example.com",
 *                       "address": "123 Solar Street, Lyon, 69001, France",
 *                       "type": "solar_panel",
 *                       "roof_orientation": "south",
 *                       "first_name": "John",
 *                       "last_name": "Solar"
 *                     },
 *                     {
 *                       "phone": "+33987654321",
 *                       "email": "solar2@example.com",
 *                       "address": "456 Sun Avenue, Marseille, 13001, France",
 *                       "type": "solar_panel",
 *                       "roof_orientation": "southeast"
 *                     }
 *                   ]
 *             mixed_leads_upload:
 *               summary: Mixed lead types JSON file
 *               value:
 *                 client_id: "456"
 *                 threshold: 80
 *                 file: |
 *                   JSON file containing:
 *                   {
 *                     "leads": [
 *                       {
 *                         "phone": "+33111111111",
 *                         "email": "insulation@example.com",
 *                         "address": "789 Old House St, Nice, 06000, France",
 *                         "type": "insulation",
 *                         "home_age": 25,
 *                         "first_name": "Jane",
 *                         "last_name": "Insulation"
 *                       },
 *                       {
 *                         "phone": "+33222222222",
 *                         "email": "evcharger@example.com",
 *                         "address": "321 Electric Ave, Toulouse, 31000, France",
 *                         "type": "ev_charger",
 *                         "garage": true,
 *                         "parking": true
 *                       },
 *                       {
 *                         "phone": "+33333333333",
 *                         "email": "insurance@example.com",
 *                         "address": "654 Safety Blvd, Bordeaux, 33000, France",
 *                         "type": "insurance",
 *                         "zip": "33000",
 *                         "city": "Bordeaux"
 *                       }
 *                     ]
 *                   }
 *     responses:
 *       202:
 *         description: File uploaded successfully and queued for processing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Upload received and queued"
 *             examples:
 *               success_upload:
 *                 summary: Successful upload response
 *                 value:
 *                   message: "Upload received and queued"
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
 *                   example: "Invalid request"
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["File is required", "client_id is required"]
 *             examples:
 *               missing_file:
 *                 summary: No file uploaded
 *                 value:
 *                   success: false
 *                   message: "File is required"
 *                   errors: ["No file uploaded"]
 *               missing_client_id:
 *                 summary: Missing client_id
 *                 value:
 *                   success: false
 *                   message: "client_id is required"
 *                   errors: ["client_id parameter is required"]
 *               invalid_json:
 *                 summary: Invalid JSON file
 *                 value:
 *                   success: false
 *                   message: "Invalid JSON file"
 *                   errors: ["File contains invalid JSON syntax"]
 *               invalid_json_structure:
 *                 summary: Invalid JSON structure
 *                 value:
 *                   success: false
 *                   message: "Invalid JSON structure"
 *                   errors: ["JSON must contain an array of leads or an object with 'leads' property"]
 *               invalid_threshold:
 *                 summary: Invalid threshold value
 *                 value:
 *                   success: false
 *                   message: "Invalid threshold"
 *                   errors: ["Threshold must be a number between 0 and 100"]
 *               invalid_file_type:
 *                 summary: Invalid file type
 *                 value:
 *                   success: false
 *                   message: "Invalid file type"
 *                   errors: ["Only JSON files are supported"]
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
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
 *                   example: "Unauthorized access"
 *             examples:
 *               unauthorized:
 *                 summary: Missing or invalid token
 *                 value:
 *                   success: false
 *                   message: "Unauthorized access"
 *       403:
 *         description: Forbidden - Supplier not authorized for this client
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
 *                   example: "Access denied"
 *             examples:
 *               forbidden:
 *                 summary: Supplier not authorized for client
 *                 value:
 *                   success: false
 *                   message: "Supplier not authorized to submit leads for this client"
 *       413:
 *         description: File too large
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
 *                   example: "File too large"
 *             examples:
 *               file_too_large:
 *                 summary: File exceeds size limit
 *                 value:
 *                   success: false
 *                   message: "File size exceeds maximum limit"
 *       415:
 *         description: Unsupported media type
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
 *                   example: "Unsupported file format"
 *             examples:
 *               unsupported_format:
 *                 summary: Non-JSON file uploaded
 *                 value:
 *                   success: false
 *                   message: "Only JSON files are supported"
 *       429:
 *         description: Too many requests - Rate limit exceeded
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
 *                   example: "Rate limit exceeded"
 *                 retry_after:
 *                   type: integer
 *                   description: Seconds to wait before retrying
 *                   example: 60
 *             examples:
 *               rate_limited:
 *                 summary: Too many upload requests
 *                 value:
 *                   success: false
 *                   message: "Rate limit exceeded. Please wait before uploading again."
 *                   retry_after: 60
 *       500:
 *         description: Internal server error
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
 *                   example: "Internal server error"
 *             examples:
 *               server_error:
 *                 summary: Server processing error
 *                 value:
 *                   success: false
 *                   message: "Internal server error occurred while processing upload"
 *
 * /api/leads/status/{uploadId}:
 *   get:
 *     summary: Get upload processing status
 *     description: |
 *       Check the processing status of an uploaded JSON file.
 *       Returns current status and progress information.
 *     tags:
 *       - Leads
 *     security:
 *       - BearerAuth: []
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
 *                     s3_key:
 *                       type: string
 *                       example: "leads/1642345678901-leads.json"
 *                     threshold:
 *                       type: integer
 *                       example: 70
 *                     status:
 *                       type: string
 *                       enum: [queued, processing, completed, failed]
 *                       example: "completed"
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-01-15T10:30:00Z"
 *                     completed_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-01-15T10:35:00Z"
 *                     total_leads:
 *                       type: integer
 *                       description: Total number of leads in the file
 *                       example: 150
 *                     processed_leads:
 *                       type: integer
 *                       description: Number of leads processed so far
 *                       example: 150
 *                     valid_leads:
 *                       type: integer
 *                       description: Number of leads that passed validation
 *                       example: 120
 *                     error_message:
 *                       type: string
 *                       description: Error message if processing failed
 *                       example: null
 *             examples:
 *               processing_complete:
 *                 summary: Processing completed successfully
 *                 value:
 *                   success: true
 *                   data:
 *                     upload_id: "12345"
 *                     client_id: "123"
 *                     s3_key: "leads/1642345678901-leads.json"
 *                     threshold: 75
 *                     status: "completed"
 *                     created_at: "2025-01-15T10:30:00Z"
 *                     completed_at: "2025-01-15T10:35:00Z"
 *                     total_leads: 100
 *                     processed_leads: 100
 *                     valid_leads: 85
 *                     error_message: null
 *               processing_failed:
 *                 summary: Processing failed
 *                 value:
 *                   success: true
 *                   data:
 *                     upload_id: "12346"
 *                     client_id: "123"
 *                     s3_key: "leads/1642345678902-invalid.json"
 *                     threshold: 70
 *                     status: "failed"
 *                     created_at: "2025-01-15T11:00:00Z"
 *                     completed_at: "2025-01-15T11:01:00Z"
 *                     total_leads: 0
 *                     processed_leads: 0
 *                     valid_leads: 0
 *                     error_message: "Invalid JSON structure in uploaded file"
 *
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
 *       - BearerAuth: []
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
 *                           description: Total leads in uploaded file
 *                           example: 150
 *                         valid:
 *                           type: integer
 *                           description: Leads that passed validation and scoring
 *                           example: 120
 *                         invalid:
 *                           type: integer
 *                           description: Leads with missing required fields or validation failures
 *                           example: 15
 *                         duplicates:
 *                           type: integer
 *                           description: Duplicate leads found (within 30 days)
 *                           example: 10
 *                         below_threshold:
 *                           type: integer
 *                           description: Leads with score below client threshold
 *                           example: 5
 *                         forwarded_to_client:
 *                           type: integer
 *                           description: Leads actually forwarded to client (valid + above threshold)
 *                           example: 85
 *                     results:
 *                       type: array
 *                       description: Individual lead processing results
 *                       items:
 *                         type: object
 *                         properties:
 *                           lead_id:
 *                             type: string
 *                             description: Unique identifier for the lead
 *                             example: "lead_uuid_123"
 *                           status:
 *                             type: string
 *                             enum: [valid, invalid, duplicate, below_threshold]
 *                             description: Processing result status
 *                             example: "valid"
 *                           score:
 *                             type: integer
 *                             minimum: 0
 *                             maximum: 100
 *                             description: Validation score (0-100)
 *                             example: 85
 *                           forwarded:
 *                             type: boolean
 *                             description: Whether lead was forwarded to client
 *                             example: true
 *                           errors:
 *                             type: array
 *                             description: List of validation errors (if any)
 *                             items:
 *                               type: string
 *                             example: []
 *                           warnings:
 *                             type: array
 *                             description: List of validation warnings (if any)
 *                             items:
 *                               type: string
 *                             example: ["Phone format could be improved"]
 *                           original_data:
 *                             type: object
 *                             description: Original lead data from uploaded file
 *                             example:
 *                               phone: "+33123456789"
 *                               email: "john@example.com"
 *                               address: "123 Main St, Paris, 75001, France"
 *                               type: "solar_panel"
 *                               roof_orientation: "south"
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
 *             examples:
 *               detailed_results:
 *                 summary: Comprehensive processing results
 *                 value:
 *                   success: true
 *                   data:
 *                     upload_id: "12345"
 *                     summary:
 *                       total_submitted: 100
 *                       valid: 85
 *                       invalid: 8
 *                       duplicates: 5
 *                       below_threshold: 2
 *                       forwarded_to_client: 83
 *                     results:
 *                       - lead_id: "lead_001"
 *                         status: "valid"
 *                         score: 100
 *                         forwarded: true
 *                         errors: []
 *                         warnings: []
 *                         original_data:
 *                           phone: "+33123456789"
 *                           email: "perfect@example.com"
 *                           address: "123 Perfect St, Paris, 75001, France"
 *                           type: "solar_panel"
 *                           roof_orientation: "south"
 *                       - lead_id: "lead_002"
 *                         status: "duplicate"
 *                         score: 0
 *                         forwarded: false
 *                         errors: ["Duplicate lead found within 30 days"]
 *                         warnings: []
 *                         original_data:
 *                           phone: "+33987654321"
 *                           email: "duplicate@example.com"
 *                           address: "456 Duplicate Ave, Lyon, 69001, France"
 *                           type: "insulation"
 *                     pagination:
 *                       current_page: 1
 *                       total_pages: 2
 *                       total_results: 100
 *                       per_page: 50
 *
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: |
 *         Supplier authentication using Bearer token.
 *         Each supplier receives a unique Bearer token for API access.
 *         Include the token in the Authorization header: `Authorization: Bearer <token>`
 */
router.post('/upload', upload.single('file'), async (req, res) => {
    const {client_id, threshold} = req.body;
    const filePath = req.file.path;
    const s3Key = `leads/${Date.now()}-${req.file.originalname}`;

    await uploadToS3(filePath, s3Key);
    fs.unlinkSync(filePath);

    await db.query(
        `INSERT INTO lead_uploads (client_id, s3_key, threshold)
         VALUES ($1, $2, $3)`,
        [client_id, s3Key, threshold || 70]
    );

    await leadQueue.add('processLeads', {
        s3Key,
        clientId: parseInt(client_id),
        threshold: parseInt(threshold || 70),
    });

    res.status(202).json({message: 'Upload received and queued'});
});

export {router}