// routes/client.js - Simplified client management without supplier relationships
import { Router } from 'express';
import { authenticate, authorize, validate } from '#middleware';
import ClientSettings from '#models/clientSettings';
import Leads from '#models/leads';
import * as yup from 'yup';

const router = Router();

// Validation schemas
const updateSettingsSchema = yup.object({
    min_lead_score: yup.number().integer().min(0).max(100).optional(),
    auto_accept_leads: yup.boolean().optional(),
    notification_email: yup.boolean().optional()
});
// Validation schema for lead status update
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
 * /api/client/settings:
 *   get:
 *     summary: Get client's lead threshold and preferences
 *     description: |
 *       Retrieve the current client's lead scoring threshold and other preferences.
 *       The threshold determines which leads the client wants to see.
 *     tags:
 *       - Client Management
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Client settings retrieved successfully
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
 *                     min_lead_score:
 *                       type: integer
 *                       example: 75
 *                       description: Minimum score threshold for lead acceptance (0-100)
 *                     auto_accept_leads:
 *                       type: boolean
 *                       example: true
 *                       description: Whether to automatically accept leads above threshold
 *                     notification_email:
 *                       type: boolean
 *                       example: true
 *                       description: Whether to send email notifications for new leads
 *                     client_name:
 *                       type: string
 *                       example: "John Smith"
 *                     client_email:
 *                       type: string
 *                       example: "john@greenenergy.com"
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/settings', authenticate, authorize(['client']), async (req, res) => {
    try {
        const clientId = req.user.id;
        const settings = await ClientSettings.getClientSettings(clientId);

        res.status(200).json({
            success: true,
            data: settings
        });
    } catch (error) {
        console.error('Get client settings error:', error);
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
 *     tags:
 *       - Client Management
 *     security:
 *       - bearerAuth: []
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
 *                 description: Minimum score threshold for lead acceptance
 *               auto_accept_leads:
 *                 type: boolean
 *                 example: true
 *                 description: Whether to automatically accept leads above threshold
 *               notification_email:
 *                 type: boolean
 *                 example: false
 *                 description: Whether to send email notifications for new leads
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
router.put('/settings', authenticate, authorize(['client']), validate(updateSettingsSchema), async (req, res) => {
    try {
        const clientId = req.user.id;
        const updates = req.body;

        const updatedSettings = await ClientSettings.updateSettings(clientId, updates);

        res.status(200).json({
            success: true,
            message: 'Settings updated successfully',
            data: updatedSettings
        });
    } catch (error) {
        console.error('Update client settings error:', error);
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
 *     tags:
 *       - Client Management
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
 *           default: 50
 *         description: Number of leads per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [all, above_threshold, below_threshold]
 *           default: all
 *         description: Filter leads by threshold status
 *       - in: query
 *         name: upload_id
 *         schema:
 *           type: integer
 *         description: Filter leads by specific upload
 *     responses:
 *       200:
 *         description: Leads retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/leads', authenticate, authorize(['client']), async (req, res) => {
    try {
        const clientId = req.user.id;
        const { page = 1, limit = 50, status = 'all', upload_id } = req.query;

        const options = {
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            uploadId: upload_id ? parseInt(upload_id) : null
        };

        const result = await Leads.getLeadsForClient(clientId, options);

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Get client leads error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
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
 *     tags:
 *       - Client Management
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
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/stats', authenticate, authorize(['client']), async (req, res) => {
    try {
        const clientId = req.user.id;
        const days = parseInt(req.query.days) || 30;

        const stats = await ClientSettings.getClientStats(clientId, days);

        res.status(200).json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Get client stats error:', error);
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
 *     tags:
 *       - Client Management
 *     security:
 *       - bearerAuth: []
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
 *                 description: ID of the lead to update
 *               status:
 *                 type: string
 *                 enum: [contacted, sold, invalid, duplicate, low_quality, not_interested, rejected, pending]
 *                 example: "contacted"
 *                 description: New status for the lead
 *     responses:
 *       200:
 *         description: Lead status updated successfully
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
 *                   example: "Lead status updated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     lead_id:
 *                       type: integer
 *                       example: 12345
 *                     old_status:
 *                       type: string
 *                       example: "pending"
 *                     new_status:
 *                       type: string
 *                       example: "contacted"
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-01-26T14:30:00Z"
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
router.put('/lead-status', authenticate, authorize(['client']), validate(updateLeadStatusSchema), async (req, res) => {
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

        res.status(200).json({
            success: true,
            message: 'Lead status updated successfully',
            data: {
                lead_id: updatedLead.id,
                old_status: oldStatus,
                new_status: updatedLead.client_status,
                updated_at: updatedLead.client_updated_at
            }
        });

    } catch (error) {
        logger.error('Update lead status error', error);
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
 *     tags:
 *       - Client Management
 *     security:
 *       - bearerAuth: []
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
 *                 description: New status for all the leads
 *     responses:
 *       200:
 *         description: Lead statuses updated successfully
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
 *                   example: "3 lead statuses updated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     updated_count:
 *                       type: integer
 *                       example: 3
 *                     status:
 *                       type: string
 *                       example: "invalid"
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-01-26T14:30:00Z"
 *       400:
 *         description: Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.put('/lead-status/bulk', authenticate, authorize(['client']), validate(bulkUpdateLeadStatusSchema), async (req, res) => {
    try {
        const clientId = req.user.id;
        const { lead_ids, status } = req.body;

        // Create placeholders for the lead IDs
        const placeholders = lead_ids.map((_, index) => `$${index + 3}`).join(', ');

        // Update multiple leads at once
        const { rowCount, rows } = await db.query(
            `UPDATE leads 
             SET client_status = $1, client_updated_at = CURRENT_TIMESTAMP
             WHERE client_id = $2 AND id IN (${placeholders})
             RETURNING id`,
            [status, clientId, ...lead_ids]
        );

        res.status(200).json({
            success: true,
            message: `${rowCount} lead status${rowCount !== 1 ? 'es' : ''} updated successfully`,
            data: {
                updated_count: rowCount,
                requested_count: lead_ids.length,
                status: status,
                updated_at: new Date().toISOString()
            }
        });

    } catch (error) {
        logger.error('Bulk update lead status error', error);
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
 *     tags:
 *       - Client Management
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
 *         description: Number of days to include in summary
 *       - in: query
 *         name: supplier_id
 *         schema:
 *           type: integer
 *         description: Filter by specific supplier
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
 *                     pending:
 *                       type: integer
 *                       example: 45
 *                     contacted:
 *                       type: integer
 *                       example: 60
 *                     sold:
 *                       type: integer
 *                       example: 15
 *                     invalid:
 *                       type: integer
 *                       example: 12
 *                     duplicate:
 *                       type: integer
 *                       example: 8
 *                     low_quality:
 *                       type: integer
 *                       example: 5
 *                     not_interested:
 *                       type: integer
 *                       example: 3
 *                     rejected:
 *                       type: integer
 *                       example: 2
 *                     conversion_rate:
 *                       type: number
 *                       example: 10.0
 *                       description: Percentage of leads that were sold
 *                     period_days:
 *                       type: integer
 *                       example: 30
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/lead-status-summary', authenticate, authorize(['client']), async (req, res) => {
    try {
        const clientId = req.user.id;
        const days = parseInt(req.query.days) || 30;
        const supplierId = req.query.supplier_id ? parseInt(req.query.supplier_id) : null;

        let query = `
            SELECT 
                COUNT(*) as total_leads,
                SUM(CASE WHEN client_status = 'pending' OR client_status IS NULL THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN client_status = 'contacted' THEN 1 ELSE 0 END) as contacted,
                SUM(CASE WHEN client_status = 'sold' THEN 1 ELSE 0 END) as sold,
                SUM(CASE WHEN client_status = 'invalid' THEN 1 ELSE 0 END) as invalid,
                SUM(CASE WHEN client_status = 'duplicate' THEN 1 ELSE 0 END) as duplicate,
                SUM(CASE WHEN client_status = 'low_quality' THEN 1 ELSE 0 END) as low_quality,
                SUM(CASE WHEN client_status = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
                SUM(CASE WHEN client_status = 'rejected' THEN 1 ELSE 0 END) as rejected
            FROM leads l
            LEFT JOIN lead_uploads lu ON lu.id = l.upload_id
            WHERE l.client_id = $1 
            AND l.created_at >= NOW() - INTERVAL '${days} days'
        `;

        const queryParams = [clientId];

        if (supplierId) {
            query += ' AND lu.supplier_id = $2';
            queryParams.push(supplierId);
        }

        const { rows } = await db.query(query, queryParams);
        const summary = rows[0];

        // Convert string numbers to integers
        const statusSummary = {
            total_leads: parseInt(summary.total_leads),
            pending: parseInt(summary.pending),
            contacted: parseInt(summary.contacted),
            sold: parseInt(summary.sold),
            invalid: parseInt(summary.invalid),
            duplicate: parseInt(summary.duplicate),
            low_quality: parseInt(summary.low_quality),
            not_interested: parseInt(summary.not_interested),
            rejected: parseInt(summary.rejected)
        };

        // Calculate conversion rate
        const conversionRate = statusSummary.total_leads > 0
            ? ((statusSummary.sold / statusSummary.total_leads) * 100).toFixed(1)
            : 0;

        res.status(200).json({
            success: true,
            data: {
                ...statusSummary,
                conversion_rate: parseFloat(conversionRate),
                period_days: days
            }
        });

    } catch (error) {
        logger.error('Get lead status summary error', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving status summary'
        });
    }
});

export default router;