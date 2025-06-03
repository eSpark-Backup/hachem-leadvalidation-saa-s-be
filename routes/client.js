// routes/client.js - Enhanced with API key authentication support
import { Router } from 'express';
import { authenticate, authorize, validate } from '#middleware';
import { authenticateClientFlexible, requireClientRole, rateLimitClientApiKey } from '#middleware/clientApiKeyAuth';
import { db } from '#config';
import ClientSettings from '#models/clientSettings';
import Leads from '#models/leads';
import * as yup from 'yup';
import { logger } from '#utils';

const router = Router();

// Validation schemas
const updateSettingsSchema = yup.object({
    min_lead_score: yup.number().integer().min(0).max(100).optional(),
    auto_accept_leads: yup.boolean().optional(),
    notification_email: yup.boolean().optional()
});

const updateLeadStatusSchema = yup.object({
    lead_id: yup.number().integer().positive().required('Lead ID is required'),
    status: yup.string()
        .oneOf(['contacted', 'sold', 'invalid', 'duplicate', 'low_quality', 'not_interested', 'rejected', 'pending'])
        .required('Status is required')
});

const bulkUpdateLeadStatusSchema = yup.object({
    lead_ids: yup.array().of(yup.number().integer().positive()).min(1).max(100).required('Lead IDs are required'),
    status: yup.string()
        .oneOf(['contacted', 'sold', 'invalid', 'duplicate', 'low_quality', 'not_interested', 'rejected', 'pending'])
        .required('Status is required')
});

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     clientBearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: JWT Bearer token for client dashboard access
 *     clientApiKey:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: API Key
 *       description: |
 *         Client API Key for programmatic access to lead data.
 *         Format: Bearer ck_your_api_key_here
 *         Example: Bearer ck_1234567890abcdef
 *     clientFlexibleAuth:
 *       anyOf:
 *         - $ref: '#/components/securitySchemes/clientBearerAuth'
 *         - $ref: '#/components/securitySchemes/clientApiKey'
 */

/**
 * @swagger
 * /api/client/settings:
 *   get:
 *     summary: Get client's lead threshold and preferences
 *     description: |
 *       Retrieve the current client's lead scoring threshold and other preferences.
 *       The threshold determines which leads the client wants to see.
 *
 *       **AUTHENTICATION**: Supports both JWT tokens and API keys.
 *     tags:
 *       - Client Management
 *     security:
 *       - clientFlexibleAuth: []
 *     responses:
 *       200:
 *         description: Client settings retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/settings', authenticateClientFlexible, requireClientRole, async (req, res) => {
    try {
        const clientId = req.user.id;
        const settings = await ClientSettings.getClientSettings(clientId);

        // Add authentication method info for API key users
        const authInfo = req.user.authType === 'api_key'
            ? { auth_method: 'api_key', key_name: req.user.keyName }
            : { auth_method: 'jwt' };

        res.status(200).json({
            success: true,
            data: { ...settings, ...authInfo }
        });
    } catch (error) {
        logger.error('Get client settings error:', {
            error: error.message,
            clientId: req.user?.id,
            authType: req.user?.authType
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * @swagger
 * /api/client/settings:
 *   put:
 *     summary: Update client's lead threshold and preferences
 *     description: |
 *       Update the client's lead scoring threshold and other preferences.
 *       This affects which leads the client will see from suppliers.
 *
 *       **AUTHENTICATION**: Supports both JWT tokens and API keys.
 *     tags:
 *       - Client Management
 *     security:
 *       - clientFlexibleAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               min_lead_score:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 100
 *                 example: 80
 *               auto_accept_leads:
 *                 type: boolean
 *                 example: true
 *               notification_email:
 *                 type: boolean
 *                 example: false
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *       400:
 *         description: Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.put('/settings', authenticateClientFlexible, requireClientRole, validate(updateSettingsSchema), async (req, res) => {
    try {
        const clientId = req.user.id;
        const updates = req.body;

        const updatedSettings = await ClientSettings.updateSettings(clientId, updates);

        logger.info('Client settings updated', {
            clientId,
            updates,
            authType: req.user.authType,
            keyName: req.user.keyName
        });

        res.status(200).json({
            success: true,
            message: 'Settings updated successfully',
            data: updatedSettings
        });
    } catch (error) {
        logger.error('Update client settings error:', {
            error: error.message,
            clientId: req.user?.id,
            authType: req.user?.authType
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * @swagger
 * /api/client/leads:
 *   get:
 *     summary: Get leads for the client based on their current threshold
 *     description: |
 *       Retrieve leads that have been sent to this client, filtered by their current threshold.
 *       Includes information about which leads meet the current threshold.
 *
 *       **AUTHENTICATION**: Supports both JWT tokens and API keys.
 *       **RATE LIMITING**: API key requests are limited to 300 requests per minute.
 *     tags:
 *       - Client Management
 *     security:
 *       - clientFlexibleAuth: []
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
 *           default: 50
 *         description: Number of leads per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [all, above_threshold, below_threshold, contacted, sold, invalid, duplicate, pending]
 *           default: all
 *         description: Filter leads by status
 *       - in: query
 *         name: supplier_id
 *         schema:
 *           type: integer
 *         description: Filter leads by specific supplier
 *       - in: query
 *         name: upload_id
 *         schema:
 *           type: integer
 *         description: Filter leads by specific upload
 *       - in: query
 *         name: date_from
 *         schema:
 *           type: string
 *           format: date
 *           example: "2025-06-01"
 *         description: Filter leads from this date (YYYY-MM-DD)
 *       - in: query
 *         name: date_to
 *         schema:
 *           type: string
 *           format: date
 *           example: "2025-06-03"
 *         description: Filter leads up to this date (YYYY-MM-DD)
 *       - in: query
 *         name: min_score
 *         schema:
 *           type: integer
 *           minimum: 0
 *           maximum: 100
 *         description: Filter leads with minimum score
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [solar_panel, insulation, ev_charger, insurance]
 *         description: Filter leads by type
 *     responses:
 *       200:
 *         description: Leads retrieved successfully
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
 *                     leads:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                             example: 12345
 *                           email:
 *                             type: string
 *                             example: "john@example.com"
 *                           phone:
 *                             type: string
 *                             example: "+33123456789"
 *                           address:
 *                             type: string
 *                             example: "123 Main St, Paris, 75001, France"
 *                           type:
 *                             type: string
 *                             example: "solar_panel"
 *                           score:
 *                             type: integer
 *                             example: 85
 *                           client_status:
 *                             type: string
 *                             nullable: true
 *                             example: "contacted"
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                             example: "2025-06-03T10:30:00Z"
 *                           client_updated_at:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
 *                             example: "2025-06-03T14:30:00Z"
 *                           supplier_info:
 *                             type: object
 *                             properties:
 *                               supplier_id:
 *                                 type: integer
 *                                 example: 456
 *                               supplier_name:
 *                                 type: string
 *                                 example: "Premium Lead Generation"
 *                           upload_info:
 *                             type: object
 *                             properties:
 *                               upload_id:
 *                                 type: integer
 *                                 example: 789
 *                               uploaded_at:
 *                                 type: string
 *                                 format: date-time
 *                                 example: "2025-06-03T09:00:00Z"
 *                           other_fields:
 *                             type: object
 *                             description: Additional lead data
 *                             example:
 *                               first_name: "John"
 *                               last_name: "Doe"
 *                               roof_orientation: "south"
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         current_page:
 *                           type: integer
 *                           example: 1
 *                         total_pages:
 *                           type: integer
 *                           example: 5
 *                         total_leads:
 *                           type: integer
 *                           example: 245
 *                         per_page:
 *                           type: integer
 *                           example: 50
 *                     filters_applied:
 *                       type: object
 *                       description: Summary of applied filters
 *                     auth_info:
 *                       type: object
 *                       properties:
 *                         method:
 *                           type: string
 *                           enum: [jwt, api_key]
 *                           example: "api_key"
 *                         key_name:
 *                           type: string
 *                           example: "CRM Integration Key"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       429:
 *         description: Rate limit exceeded (API key users only)
 *       500:
 *         description: Internal server error
 */
router.get('/leads', authenticateClientFlexible, requireClientRole, async (req, res) => {
    try {
        const clientId = req.user.id;
        const {
            page = 1,
            limit = 50,
            status = 'all',
            supplier_id,
            upload_id,
            date_from,
            date_to,
            min_score,
            type
        } = req.query;

        // Validate parameters
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset = (pageNum - 1) * limitNum;

        // Get client's current threshold
        const clientSettings = await ClientSettings.getClientSettings(clientId);
        const threshold = clientSettings.min_lead_score;

        // Build dynamic query
        let query = `
            SELECT
                l.id,
                l.email,
                l.phone,
                l.address,
                l.type,
                l.score,
                l.client_status,
                l.other_fields,
                l.created_at,
                l.client_updated_at,
                lu.id as upload_id,
                lu.uploaded_at,
                lu.supplier_id,
                u.fullname as supplier_name,
                CASE
                    WHEN l.score >= $2 THEN 'above_threshold'
                    WHEN l.score = 0 THEN 'duplicate'
                    WHEN l.score < $2 AND l.score > 0 THEN 'below_threshold'
                    ELSE 'invalid'
                    END as processing_status
            FROM leads l
                     LEFT JOIN lead_uploads lu ON lu.id = l.upload_id
                     LEFT JOIN users u ON u.id = lu.supplier_id
            WHERE l.client_id = $1
        `;

        const queryParams = [clientId, threshold];
        let paramCounter = 3;

        // Apply filters
        if (status !== 'all') {
            if (status === 'above_threshold') {
                query += ` AND l.score >= $${paramCounter}`;
                queryParams.push(threshold);
                paramCounter++;
            } else if (status === 'below_threshold') {
                query += ` AND l.score < $${paramCounter} AND l.score > 0`;
                queryParams.push(threshold);
                paramCounter++;
            } else if (status === 'duplicate') {
                query += ` AND l.score = 0`;
            } else if (status === 'invalid') {
                query += ` AND l.score IS NULL`;
            } else {
                // Client status filter
                query += ` AND l.client_status = $${paramCounter}`;
                queryParams.push(status);
                paramCounter++;
            }
        }

        if (supplier_id) {
            query += ` AND lu.supplier_id = $${paramCounter}`;
            queryParams.push(parseInt(supplier_id));
            paramCounter++;
        }

        if (upload_id) {
            query += ` AND l.upload_id = $${paramCounter}`;
            queryParams.push(parseInt(upload_id));
            paramCounter++;
        }

        if (date_from) {
            query += ` AND l.created_at >= $${paramCounter}`;
            queryParams.push(date_from);
            paramCounter++;
        }

        if (date_to) {
            query += ` AND l.created_at <= $${paramCounter}::date + interval '1 day'`;
            queryParams.push(date_to);
            paramCounter++;
        }

        if (min_score) {
            query += ` AND l.score >= $${paramCounter}`;
            queryParams.push(parseInt(min_score));
            paramCounter++;
        }

        if (type) {
            query += ` AND l.type = $${paramCounter}`;
            queryParams.push(type);
            paramCounter++;
        }

        // Add pagination
        query += ` ORDER BY l.created_at DESC LIMIT $${paramCounter} OFFSET $${paramCounter + 1}`;
        queryParams.push(limitNum, offset);

        // Get total count for pagination
        const countQuery = query.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM')
            .replace(/ORDER BY[\s\S]*$/, '');
        const countParams = queryParams.slice(0, -2); // Remove limit and offset

        const [leadsResponse, countResponse] = await Promise.all([
            db.query(query, queryParams),
            db.query(countQuery, countParams)
        ]);

        const leads = leadsResponse.rows.map(lead => ({
            id: lead.id,
            email: lead.email,
            phone: lead.phone,
            address: lead.address,
            type: lead.type,
            score: lead.score || 0,
            processing_status: lead.processing_status,
            client_status: lead.client_status,
            created_at: lead.created_at,
            client_updated_at: lead.client_updated_at,
            supplier_info: {
                supplier_id: lead.supplier_id,
                supplier_name: lead.supplier_name
            },
            upload_info: {
                upload_id: lead.upload_id,
                uploaded_at: lead.uploaded_at
            },
            other_fields: lead.other_fields || {}
        }));

        const totalLeads = parseInt(countResponse.rows[0].total);
        const totalPages = Math.ceil(totalLeads / limitNum);

        // Log API usage for monitoring
        if (req.user.authType === 'api_key') {
            logger.info('Client API lead fetch', {
                clientId,
                keyName: req.user.keyName,
                resultsCount: leads.length,
                filters: { status, supplier_id, upload_id, date_from, date_to, min_score, type }
            });
        }

        res.status(200).json({
            success: true,
            data: {
                leads,
                pagination: {
                    current_page: pageNum,
                    total_pages: totalPages,
                    total_leads: totalLeads,
                    per_page: limitNum
                },
                filters_applied: {
                    status,
                    supplier_id: supplier_id ? parseInt(supplier_id) : null,
                    upload_id: upload_id ? parseInt(upload_id) : null,
                    date_from,
                    date_to,
                    min_score: min_score ? parseInt(min_score) : null,
                    type,
                    client_threshold: threshold
                },
                auth_info: {
                    method: req.user.authType || 'jwt',
                    key_name: req.user.keyName || null
                }
            }
        });
    } catch (error) {
        logger.error('Get client leads error:', {
            error: error.message,
            clientId: req.user?.id,
            authType: req.user?.authType,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * @swagger
 * /api/client/lead-status:
 *   put:
 *     summary: Update lead status
 *     description: |
 *       Update the status of a specific lead. This allows clients to provide feedback
 *       on the leads they receive, marking them as contacted, sold, invalid, etc.
 *
 *       **AUTHENTICATION**: Supports both JWT tokens and API keys.
 *     tags:
 *       - Client Management
 *     security:
 *       - clientFlexibleAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - lead_id
 *               - status
 *             properties:
 *               lead_id:
 *                 type: integer
 *                 example: 12345
 *               status:
 *                 type: string
 *                 enum: [contacted, sold, invalid, duplicate, low_quality, not_interested, rejected, pending]
 *                 example: "contacted"
 *     responses:
 *       200:
 *         description: Lead status updated successfully
 *       400:
 *         description: Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       404:
 *         description: Lead not found or doesn't belong to this client
 *       500:
 *         description: Internal server error
 */
router.put('/lead-status', authenticateClientFlexible, requireClientRole, validate(updateLeadStatusSchema), async (req, res) => {
    try {
        const clientId = req.user.id;
        const { lead_id, status } = req.body;

        // First, get the current lead status
        const { rows: currentRows } = await db.query(
            'SELECT id, client_status FROM leads WHERE id = $1 AND client_id = $2',
            [lead_id, clientId]
        );

        if (currentRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead not found or access denied'
            });
        }

        const oldStatus = currentRows[0].client_status;

        // Update the lead status
        const { rows } = await db.query(
            `UPDATE leads 
             SET client_status = $1, client_updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND client_id = $3
             RETURNING id, client_status, client_updated_at`,
            [status, lead_id, clientId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead not found or access denied'
            });
        }

        const updatedLead = rows[0];

        // Log the update
        logger.info('Lead status updated', {
            leadId: lead_id,
            clientId,
            oldStatus,
            newStatus: status,
            authType: req.user.authType,
            keyName: req.user.keyName
        });

        res.status(200).json({
            success: true,
            message: 'Lead status updated successfully',
            data: {
                lead_id: updatedLead.id,
                old_status: oldStatus,
                new_status: updatedLead.client_status,
                updated_at: updatedLead.client_updated_at,
                auth_method: req.user.authType || 'jwt'
            }
        });

    } catch (error) {
        logger.error('Update lead status error', {
            error: error.message,
            clientId: req.user?.id,
            authType: req.user?.authType,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating lead status'
        });
    }
});

/**
 * @swagger
 * /api/client/lead-status/bulk:
 *   put:
 *     summary: Update multiple lead statuses
 *     description: |
 *       Update the status of multiple leads at once. Useful for bulk operations
 *       when clients want to mark multiple leads with the same status.
 *
 *       **AUTHENTICATION**: Supports both JWT tokens and API keys.
 *     tags:
 *       - Client Management
 *     security:
 *       - clientFlexibleAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - lead_ids
 *               - status
 *             properties:
 *               lead_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 example: [12345, 12346, 12347]
 *                 description: Array of lead IDs to update (max 100)
 *               status:
 *                 type: string
 *                 enum: [contacted, sold, invalid, duplicate, low_quality, not_interested, rejected, pending]
 *                 example: "invalid"
 *     responses:
 *       200:
 *         description: Lead statuses updated successfully
 *       400:
 *         description: Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.put('/lead-status/bulk', authenticateClientFlexible, requireClientRole, validate(bulkUpdateLeadStatusSchema), async (req, res) => {
    try {
        const clientId = req.user.id;
        const { lead_ids, status } = req.body;

        // Create placeholders for the lead IDs
        const placeholders = lead_ids.map((_, index) => `${index + 3}`).join(', ');

        // Update multiple leads at once
        const { rowCount, rows } = await db.query(
            `UPDATE leads 
             SET client_status = $1, client_updated_at = CURRENT_TIMESTAMP
             WHERE client_id = $2 AND id IN (${placeholders})
             RETURNING id`,
            [status, clientId, ...lead_ids]
        );

        // Log the bulk update
        logger.info('Bulk lead status update', {
            leadIds: lead_ids,
            clientId,
            status,
            updatedCount: rowCount,
            authType: req.user.authType,
            keyName: req.user.keyName
        });

        res.status(200).json({
            success: true,
            message: `${rowCount} lead status${rowCount !== 1 ? 'es' : ''} updated successfully`,
            data: {
                updated_count: rowCount,
                requested_count: lead_ids.length,
                status: status,
                updated_at: new Date().toISOString(),
                auth_method: req.user.authType || 'jwt'
            }
        });

    } catch (error) {
        logger.error('Bulk update lead status error', {
            error: error.message,
            clientId: req.user?.id,
            authType: req.user?.authType,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating lead statuses'
        });
    }
});

/**
 * @swagger
 * /api/client/lead-status-summary:
 *   get:
 *     summary: Get lead status summary for client
 *     description: |
 *       Get a summary of lead statuses for the client showing counts
 *       of leads in each status category.
 *
 *       **AUTHENTICATION**: Supports both JWT tokens and API keys.
 *     tags:
 *       - Client Management
 *     security:
 *       - clientFlexibleAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *           default: 30
 *         description: Number of days to include in summary
 *       - in: query
 *         name: supplier_id
 *         schema:
 *           type: integer
 *         description: Filter by specific supplier
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [solar_panel, insulation, ev_charger, insurance]
 *         description: Filter by lead type
 *     responses:
 *       200:
 *         description: Status summary retrieved successfully
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
 *                     total_leads:
 *                       type: integer
 *                       example: 150
 *                     above_threshold:
 *                       type: integer
 *                       example: 120
 *                     below_threshold:
 *                       type: integer
 *                       example: 15
 *                     duplicates:
 *                       type: integer
 *                       example: 10
 *                     invalid:
 *                       type: integer
 *                       example: 5
 *                     status_breakdown:
 *                       type: object
 *                       properties:
 *                         pending:
 *                           type: integer
 *                           example: 45
 *                         contacted:
 *                           type: integer
 *                           example: 60
 *                         sold:
 *                           type: integer
 *                           example: 15
 *                         invalid:
 *                           type: integer
 *                           example: 12
 *                         duplicate:
 *                           type: integer
 *                           example: 8
 *                         low_quality:
 *                           type: integer
 *                           example: 5
 *                         not_interested:
 *                           type: integer
 *                           example: 3
 *                         rejected:
 *                           type: integer
 *                           example: 2
 *                     conversion_rate:
 *                       type: number
 *                       example: 10.0
 *                       description: Percentage of leads that were sold
 *                     period_days:
 *                       type: integer
 *                       example: 30
 *                     auth_info:
 *                       type: object
 *                       properties:
 *                         method:
 *                           type: string
 *                           enum: [jwt, api_key]
 *                           example: "api_key"
 *                         key_name:
 *                           type: string
 *                           example: "CRM Integration Key"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/lead-status-summary', authenticateClientFlexible, requireClientRole, async (req, res) => {
    try {
        const clientId = req.user.id;
        const days = parseInt(req.query.days) || 30;
        const supplierId = req.query.supplier_id ? parseInt(req.query.supplier_id) : null;
        const type = req.query.type;

        // Get client threshold
        const clientSettings = await ClientSettings.getClientSettings(clientId);
        const threshold = clientSettings.min_lead_score;

        let query = `
            SELECT 
                COUNT(*) as total_leads,
                SUM(CASE WHEN l.score >= $2 THEN 1 ELSE 0 END) as above_threshold,
                SUM(CASE WHEN l.score < $2 AND l.score > 0 THEN 1 ELSE 0 END) as below_threshold,
                SUM(CASE WHEN l.score = 0 THEN 1 ELSE 0 END) as duplicates,
                SUM(CASE WHEN l.score IS NULL THEN 1 ELSE 0 END) as invalid,
                SUM(CASE WHEN l.client_status = 'pending' OR l.client_status IS NULL THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN l.client_status = 'contacted' THEN 1 ELSE 0 END) as contacted,
                SUM(CASE WHEN l.client_status = 'sold' THEN 1 ELSE 0 END) as sold,
                SUM(CASE WHEN l.client_status = 'invalid' THEN 1 ELSE 0 END) as status_invalid,
                SUM(CASE WHEN l.client_status = 'duplicate' THEN 1 ELSE 0 END) as status_duplicate,
                SUM(CASE WHEN l.client_status = 'low_quality' THEN 1 ELSE 0 END) as low_quality,
                SUM(CASE WHEN l.client_status = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
                SUM(CASE WHEN l.client_status = 'rejected' THEN 1 ELSE 0 END) as rejected
            FROM leads l
            LEFT JOIN lead_uploads lu ON lu.id = l.upload_id
            WHERE l.client_id = $1 
            AND l.created_at >= NOW() - INTERVAL '${days} days'
        `;

        const queryParams = [clientId, threshold];
        let paramCounter = 3;

        if (supplierId) {
            query += ` AND lu.supplier_id = ${paramCounter}`;
            queryParams.push(supplierId);
            paramCounter++;
        }

        if (type) {
            query += ` AND l.type = ${paramCounter}`;
            queryParams.push(type);
            paramCounter++;
        }

        const { rows } = await db.query(query, queryParams);
        const summary = rows[0];

        // Convert string numbers to integers
        const statusSummary = {
            total_leads: parseInt(summary.total_leads),
            above_threshold: parseInt(summary.above_threshold),
            below_threshold: parseInt(summary.below_threshold),
            duplicates: parseInt(summary.duplicates),
            invalid: parseInt(summary.invalid),
            status_breakdown: {
                pending: parseInt(summary.pending),
                contacted: parseInt(summary.contacted),
                sold: parseInt(summary.sold),
                invalid: parseInt(summary.status_invalid),
                duplicate: parseInt(summary.status_duplicate),
                low_quality: parseInt(summary.low_quality),
                not_interested: parseInt(summary.not_interested),
                rejected: parseInt(summary.rejected)
            }
        };

        // Calculate conversion rate
        const conversionRate = statusSummary.total_leads > 0
            ? ((statusSummary.status_breakdown.sold / statusSummary.total_leads) * 100).toFixed(1)
            : 0;

        // Log API usage for monitoring
        if (req.user.authType === 'api_key') {
            logger.info('Client API status summary fetch', {
                clientId,
                keyName: req.user.keyName,
                filters: { days, supplierId, type }
            });
        }

        res.status(200).json({
            success: true,
            data: {
                ...statusSummary,
                conversion_rate: parseFloat(conversionRate),
                period_days: days,
                client_threshold: threshold,
                filters_applied: {
                    days,
                    supplier_id: supplierId,
                    type
                },
                auth_info: {
                    method: req.user.authType || 'jwt',
                    key_name: req.user.keyName || null
                }
            }
        });

    } catch (error) {
        logger.error('Get lead status summary error', {
            error: error.message,
            clientId: req.user?.id,
            authType: req.user?.authType,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving status summary'
        });
    }
});

/**
 * @swagger
 * /api/client/stats:
 *   get:
 *     summary: Get client statistics and threshold analysis
 *     description: |
 *       Get comprehensive statistics for the client including how their current
 *       threshold affects the leads they receive.
 *
 *       **AUTHENTICATION**: Supports both JWT tokens and API keys.
 *     tags:
 *       - Client Management
 *     security:
 *       - clientFlexibleAuth: []
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
 *                     current_threshold:
 *                       type: integer
 *                       example: 75
 *                     total_uploads:
 *                       type: integer
 *                       example: 25
 *                     unique_suppliers:
 *                       type: integer
 *                       example: 5
 *                     total_leads_received:
 *                       type: integer
 *                       example: 2500
 *                     leads_above_threshold:
 *                       type: integer
 *                       example: 2100
 *                     average_lead_score:
 *                       type: number
 *                       example: 78.5
 *                     period_days:
 *                       type: integer
 *                       example: 30
 *                     auth_info:
 *                       type: object
 *                       properties:
 *                         method:
 *                           type: string
 *                           enum: [jwt, api_key]
 *                           example: "api_key"
 *                         key_name:
 *                           type: string
 *                           example: "CRM Integration Key"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/stats', authenticateClientFlexible, requireClientRole, async (req, res) => {
    try {
        const clientId = req.user.id;
        const days = parseInt(req.query.days) || 30;

        const stats = await ClientSettings.getClientStats(clientId, days);

        // Log API usage for monitoring
        if (req.user.authType === 'api_key') {
            logger.info('Client API stats fetch', {
                clientId,
                keyName: req.user.keyName,
                days
            });
        }

        res.status(200).json({
            success: true,
            data: {
                ...stats,
                period_days: days,
                auth_info: {
                    method: req.user.authType || 'jwt',
                    key_name: req.user.keyName || null
                }
            }
        });
    } catch (error) {
        logger.error('Get client stats error', {
            error: error.message,
            clientId: req.user?.id,
            authType: req.user?.authType,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

export default router;