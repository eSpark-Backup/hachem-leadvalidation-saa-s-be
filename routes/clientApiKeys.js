// routes/clientApiKeys.js - Client API key management routes
import { Router } from 'express';
import { authenticate, authorize, validate } from '#middleware';
import ClientApiKeys from '#models/clientApiKeys';
import * as yup from 'yup';
import { logger } from '#utils';

const router = Router();

// Validation schemas
const createApiKeySchema = yup.object({
    key_name: yup.string()
        .min(3, 'Key name must be at least 3 characters')
        .max(50, 'Key name must be at most 50 characters')
        .matches(/^[a-zA-Z0-9_\-\s]+$/, 'Key name can only contain letters, numbers, spaces, hyphens, and underscores')
        .required('Key name is required')
});

const revokeApiKeySchema = yup.object({
    reason: yup.string()
        .max(255, 'Reason must be at most 255 characters')
        .optional()
});

/**
 * @swagger
 * /api/client/api-keys:
 *   get:
 *     summary: Get all API keys for the current client
 *     description: |
 *       Retrieve all API keys associated with the current client account.
 *       Shows key details but never returns the actual key values for security.
 *       Only the key prefix (first 8 characters) is shown for identification.
 *     tags:
 *       - Client API Keys
 *     security:
 *       - clientBearerAuth: []
 *     responses:
 *       200:
 *         description: API keys retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                         description: Unique identifier for the API key
 *                         example: 1
 *                       key_name:
 *                         type: string
 *                         description: Human-readable name for the API key
 *                         example: "CRM Integration Key"
 *                       key_prefix:
 *                         type: string
 *                         description: First 8-10 characters of the API key for identification
 *                         example: "ck_a1b2c3d4"
 *                       is_active:
 *                         type: boolean
 *                         description: Whether the key is currently active
 *                         example: true
 *                       last_used_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         example: "2025-06-03T14:30:00Z"
 *                       usage_count:
 *                         type: integer
 *                         example: 156
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         example: "2025-06-01T10:00:00Z"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.get('/', authenticate, authorize(['client']), async (req, res) => {
    try {
        const clientId = req.user.id;
        const apiKeys = await ClientApiKeys.getClientApiKeys(clientId);

        res.status(200).json({
            success: true,
            data: apiKeys,
            message: apiKeys.length === 0
                ? "No API keys found. Create your first API key to start fetching leads programmatically."
                : `Found ${apiKeys.length} API key(s)`
        });
    } catch (error) {
        logger.error('Get client API keys error', {
            error: error.message,
            clientId: req.user?.id,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving API keys'
        });
    }
});

/**
 * @swagger
 * /api/client/api-keys:
 *   post:
 *     summary: Create a new client API key
 *     description: |
 *       Generate a new API key for programmatic lead access. The full API key is only shown once
 *       upon creation and cannot be retrieved again. Store it securely!
 *
 *       **IMPORTANT**: Save the returned API key immediately. It will never be shown again
 *       for security reasons. If you lose it, you'll need to create a new one.
 *
 *       The generated key format is: `ck_` followed by 64 hexadecimal characters.
 *       Use this key in the Authorization header for lead access: `Bearer ck_your_key_here`
 *     tags:
 *       - Client API Keys
 *     security:
 *       - clientBearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - key_name
 *             properties:
 *               key_name:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 50
 *                 pattern: '^[a-zA-Z0-9_\-\s]+$'
 *                 description: |
 *                   Human-readable name for the API key. Use descriptive names
 *                   like "CRM Integration", "Webhook Service", etc.
 *                 example: "CRM Integration Key"
 *     responses:
 *       201:
 *         description: API key created successfully
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
 *                   example: "API key created successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 1
 *                     key_name:
 *                       type: string
 *                       example: "CRM Integration Key"
 *                     api_key:
 *                       type: string
 *                       description: "Full API key - ONLY SHOWN ONCE!"
 *                       example: "ck_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2"
 *                     key_prefix:
 *                       type: string
 *                       example: "ck_a1b2c3d4"
 *                     is_active:
 *                       type: boolean
 *                       example: true
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-06-03T15:00:00Z"
 *                 warning:
 *                   type: string
 *                   example: "⚠️  IMPORTANT: Store this API key securely. It will not be shown again!"
 *       400:
 *         description: Bad request - Invalid input or key name already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.post('/', authenticate, authorize(['client']), validate(createApiKeySchema), async (req, res) => {
    try {
        const clientId = req.user.id;
        const { key_name } = req.body;

        const newApiKey = await ClientApiKeys.createApiKey(clientId, key_name, req.user.id);

        logger.info('Client API key created successfully', {
            clientId,
            keyName: key_name,
            keyId: newApiKey.id,
            keyPrefix: newApiKey.key_prefix
        });

        res.status(201).json({
            success: true,
            message: 'API key created successfully',
            data: newApiKey,
            warning: '⚠️  IMPORTANT: Store this API key securely. It will not be shown again!',
            usage_instructions: {
                description: 'Use this API key to fetch your leads programmatically',
                header: 'Authorization: Bearer ' + newApiKey.api_key,
                endpoints: [
                    'GET /api/client/leads',
                    'GET /api/client/lead-status-summary',
                    'PUT /api/client/lead-status'
                ]
            }
        });
    } catch (error) {
        if (error.message.includes('already exists')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        logger.error('Create client API key error', {
            error: error.message,
            clientId: req.user?.id,
            keyName: req.body?.key_name,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while creating API key'
        });
    }
});

/**
 * @swagger
 * /api/client/api-keys/{keyId}/revoke:
 *   put:
 *     summary: Revoke a client API key
 *     description: |
 *       Revoke an API key to prevent further use. Revoked keys can be reactivated later
 *       if needed. This immediately stops the key from working for lead access.
 *     tags:
 *       - Client API Keys
 *     security:
 *       - clientBearerAuth: []
 *     parameters:
 *       - in: path
 *         name: keyId
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: ID of the API key to revoke
 *         example: 1
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 maxLength: 255
 *                 description: Optional reason for revoking the key
 *                 example: "Security concern - potential compromise"
 *     responses:
 *       200:
 *         description: API key revoked successfully
 *       400:
 *         description: Bad request - Key not found or already revoked
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.put('/:keyId/revoke', authenticate, authorize(['client']), validate(revokeApiKeySchema), async (req, res) => {
    try {
        const clientId = req.user.id;
        const keyId = parseInt(req.params.keyId);
        const { reason } = req.body;

        if (isNaN(keyId) || keyId < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid key ID'
            });
        }

        const revokedKey = await ClientApiKeys.revokeApiKey(keyId, clientId, req.user.id, reason);

        logger.info('Client API key revoked', {
            keyId,
            clientId,
            keyName: revokedKey.key_name,
            reason: reason || 'No reason provided'
        });

        res.status(200).json({
            success: true,
            message: 'API key revoked successfully',
            data: {
                id: revokedKey.id,
                key_name: revokedKey.key_name,
                key_prefix: revokedKey.key_prefix,
                revoked_at: new Date().toISOString(),
                reason: reason || null
            }
        });
    } catch (error) {
        if (error.message.includes('not found') || error.message.includes('already revoked')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        logger.error('Revoke client API key error', {
            error: error.message,
            keyId: req.params.keyId,
            clientId: req.user?.id,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while revoking API key'
        });
    }
});

/**
 * @swagger
 * /api/client/api-keys/{keyId}/reactivate:
 *   put:
 *     summary: Reactivate a revoked client API key
 *     description: |
 *       Reactivate a previously revoked API key. The key will immediately
 *       become usable again for lead access with the same API key value.
 *     tags:
 *       - Client API Keys
 *     security:
 *       - clientBearerAuth: []
 *     parameters:
 *       - in: path
 *         name: keyId
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: ID of the API key to reactivate
 *         example: 1
 *     responses:
 *       200:
 *         description: API key reactivated successfully
 *       400:
 *         description: Bad request - Key not found or already active
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.put('/:keyId/reactivate', authenticate, authorize(['client']), async (req, res) => {
    try {
        const clientId = req.user.id;
        const keyId = parseInt(req.params.keyId);

        if (isNaN(keyId) || keyId < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid key ID'
            });
        }

        const reactivatedKey = await ClientApiKeys.reactivateApiKey(keyId, clientId);

        logger.info('Client API key reactivated', {
            keyId,
            clientId,
            keyName: reactivatedKey.key_name
        });

        res.status(200).json({
            success: true,
            message: 'API key reactivated successfully',
            data: {
                id: reactivatedKey.id,
                key_name: reactivatedKey.key_name,
                key_prefix: reactivatedKey.key_prefix,
                reactivated_at: new Date().toISOString()
            },
            note: 'The API key is now active and can be used for lead access'
        });
    } catch (error) {
        if (error.message.includes('not found') || error.message.includes('already active')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        logger.error('Reactivate client API key error', {
            error: error.message,
            keyId: req.params.keyId,
            clientId: req.user?.id,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while reactivating API key'
        });
    }
});

/**
 * @swagger
 * /api/client/api-keys/{keyId}:
 *   delete:
 *     summary: Delete a client API key permanently
 *     description: |
 *       Permanently delete an API key. This action cannot be undone.
 *       The key will be completely removed from the system.
 *
 *       ⚠️  **WARNING**: This is permanent! Consider revoking instead if you might need it again.
 *     tags:
 *       - Client API Keys
 *     security:
 *       - clientBearerAuth: []
 *     parameters:
 *       - in: path
 *         name: keyId
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: ID of the API key to delete permanently
 *         example: 1
 *     responses:
 *       200:
 *         description: API key deleted successfully
 *       400:
 *         description: Bad request - Key not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Only clients can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.delete('/:keyId', authenticate, authorize(['client']), async (req, res) => {
    try {
        const clientId = req.user.id;
        const keyId = parseInt(req.params.keyId);

        if (isNaN(keyId) || keyId < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid key ID'
            });
        }

        const deletedKey = await ClientApiKeys.deleteApiKey(keyId, clientId);

        logger.info('Client API key deleted permanently', {
            keyId,
            clientId,
            keyName: deletedKey.key_name
        });

        res.status(200).json({
            success: true,
            message: 'API key deleted permanently',
            data: {
                id: deletedKey.id,
                key_name: deletedKey.key_name,
                key_prefix: deletedKey.key_prefix,
                deleted_at: new Date().toISOString()
            },
            warning: 'This action cannot be undone. The API key has been permanently deleted.'
        });
    } catch (error) {
        if (error.message.includes('not found')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        logger.error('Delete client API key error', {
            error: error.message,
            keyId: req.params.keyId,
            clientId: req.user?.id,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting API key'
        });
    }
});

/**
 * @swagger
 * /api/client/api-keys/stats:
 *   get:
 *     summary: Get client API key usage statistics
 *     description: |
 *       Get comprehensive statistics about the client's API key usage
 *       including total usage, active keys, and recent activity.
 *     tags:
 *       - Client API Keys
 *     security:
 *       - clientBearerAuth: []
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
 *                     total_keys:
 *                       type: integer
 *                       example: 3
 *                     active_keys:
 *                       type: integer
 *                       example: 2
 *                     revoked_keys:
 *                       type: integer
 *                       example: 1
 *                     total_usage:
 *                       type: integer
 *                       example: 1250
 *                     last_activity:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-06-03T14:30:00Z"
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

        const stats = await ClientApiKeys.getApiKeyStats(clientId, days);

        res.status(200).json({
            success: true,
            data: stats
        });
    } catch (error) {
        logger.error('Get client API key stats error', {
            error: error.message,
            clientId: req.user?.id,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving API key statistics'
        });
    }
});

export default router;