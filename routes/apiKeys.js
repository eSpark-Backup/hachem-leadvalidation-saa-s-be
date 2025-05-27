// routes/apiKeys.js - Complete API key management routes for suppliers
import { Router } from 'express';
import { authenticate, authorize, validate } from '#middleware';
import ApiKeys from '#models/apiKeys';
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
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *     apiKeyAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: API Key
 */

/**
 * @swagger
 * /api/api-keys:
 *   get:
 *     summary: Get all API keys for the current supplier
 *     description: |
 *       Retrieve all API keys associated with the current supplier account.
 *       Shows key details but never returns the actual key values for security.
 *       Only the key prefix (first 8 characters) is shown for identification.
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
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
 *                         example: "Production Upload Key"
 *                       key_prefix:
 *                         type: string
 *                         description: First 8-10 characters of the API key for identification
 *                         example: "sk_a1b2c3d4"
 *                       is_active:
 *                         type: boolean
 *                         description: Whether the key is currently active
 *                         example: true
 *                       last_used_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         description: Timestamp of last successful authentication
 *                         example: "2025-01-26T14:30:00Z"
 *                       last_used_ip:
 *                         type: string
 *                         nullable: true
 *                         description: IP address of last usage
 *                         example: "192.168.1.100"
 *                       usage_count:
 *                         type: integer
 *                         description: Number of times this key has been used
 *                         example: 45
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         description: When the key was created
 *                         example: "2025-01-20T10:00:00Z"
 *                       revoked_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         description: When the key was revoked (if applicable)
 *                         example: null
 *                       revoke_reason:
 *                         type: string
 *                         nullable: true
 *                         description: Reason for revoking the key (if applicable)
 *                         example: null
 *             examples:
 *               success_response:
 *                 summary: Successful API key list
 *                 value:
 *                   success: true
 *                   data:
 *                     - id: 1
 *                       key_name: "Production Upload Key"
 *                       key_prefix: "sk_a1b2c3d4"
 *                       is_active: true
 *                       last_used_at: "2025-01-26T14:30:00Z"
 *                       last_used_ip: "192.168.1.100"
 *                       usage_count: 45
 *                       created_at: "2025-01-20T10:00:00Z"
 *                       revoked_at: null
 *                       revoke_reason: null
 *                     - id: 2
 *                       key_name: "Development Key"
 *                       key_prefix: "sk_x9y8z7w6"
 *                       is_active: false
 *                       last_used_at: "2025-01-25T09:15:00Z"
 *                       last_used_ip: "10.0.0.50"
 *                       usage_count: 23
 *                       created_at: "2025-01-15T08:00:00Z"
 *                       revoked_at: "2025-01-25T16:00:00Z"
 *                       revoke_reason: "Switched to production key"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
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
 *                   example: "Invalid or expired access token"
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
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
 *                   example: "Insufficient permissions"
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
 *                   example: "Internal server error while retrieving API keys"
 */
router.get('/', authenticate, authorize(['supplier']), async (req, res) => {
    try {
        const supplierId = req.user.id;
        const apiKeys = await ApiKeys.getSupplierApiKeys(supplierId);

        res.status(200).json({
            success: true,
            data: apiKeys,
            message: apiKeys.length === 0
                ? "No API keys found. Create your first API key to start uploading leads."
                : `Found ${apiKeys.length} API key(s)`
        });
    } catch (error) {
        logger.error('Get API keys error', {
            error: error.message,
            supplierId: req.user?.id,
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
 * /api/api-keys:
 *   post:
 *     summary: Create a new API key
 *     description: |
 *       Generate a new API key for lead uploads. The full API key is only shown once
 *       upon creation and cannot be retrieved again. Store it securely!
 *
 *       **IMPORTANT**: Save the returned API key immediately. It will never be shown again
 *       for security reasons. If you lose it, you'll need to create a new one.
 *
 *       The generated key format is: `sk_` followed by 64 hexadecimal characters.
 *       Use this key in the Authorization header for lead uploads: `Bearer sk_your_key_here`
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
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
 *                   like "Production Server", "Development Environment", etc.
 *                 example: "Production Upload Key"
 *           examples:
 *             production_key:
 *               summary: Production environment key
 *               value:
 *                 key_name: "Production Upload Key"
 *             development_key:
 *               summary: Development environment key
 *               value:
 *                 key_name: "Development Testing Key"
 *             integration_key:
 *               summary: Third-party integration key
 *               value:
 *                 key_name: "CRM Integration Key"
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
 *                       description: Unique identifier for the new API key
 *                       example: 1
 *                     key_name:
 *                       type: string
 *                       description: Name of the API key
 *                       example: "Production Upload Key"
 *                     api_key:
 *                       type: string
 *                       description: "Full API key - ONLY SHOWN ONCE!"
 *                       example: "sk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2"
 *                     key_prefix:
 *                       type: string
 *                       description: First 8-10 characters for identification
 *                       example: "sk_a1b2c3d4"
 *                     is_active:
 *                       type: boolean
 *                       example: true
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-01-26T15:00:00Z"
 *                 warning:
 *                   type: string
 *                   example: "⚠️  IMPORTANT: Store this API key securely. It will not be shown again!"
 *             examples:
 *               successful_creation:
 *                 summary: Successful API key creation
 *                 value:
 *                   success: true
 *                   message: "API key created successfully"
 *                   data:
 *                     id: 1
 *                     key_name: "Production Upload Key"
 *                     api_key: "sk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2"
 *                     key_prefix: "sk_a1b2c3d4"
 *                     is_active: true
 *                     created_at: "2025-01-26T15:00:00Z"
 *                   warning: "⚠️  IMPORTANT: Store this API key securely. It will not be shown again!"
 *       400:
 *         description: Bad request - Invalid input or key name already exists
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
 *                 errors:
 *                   type: object
 *             examples:
 *               duplicate_name:
 *                 summary: Key name already exists
 *                 value:
 *                   success: false
 *                   message: "API key name already exists for this supplier"
 *               invalid_name:
 *                 summary: Invalid key name format
 *                 value:
 *                   success: false
 *                   message: "Validation failed"
 *                   errors:
 *                     key_name: "Key name can only contain letters, numbers, spaces, hyphens, and underscores"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.post('/', authenticate, authorize(['supplier']), validate(createApiKeySchema), async (req, res) => {
    try {
        const supplierId = req.user.id;
        const { key_name } = req.body;

        const newApiKey = await ApiKeys.createApiKey(supplierId, key_name, req.user.id);

        logger.info('API key created successfully', {
            supplierId,
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
                description: 'Use this API key for lead uploads',
                header: 'Authorization: Bearer ' + newApiKey.api_key,
                endpoint: 'POST /api/leads/upload'
            }
        });
    } catch (error) {
        if (error.message.includes('already exists')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        logger.error('Create API key error', {
            error: error.message,
            supplierId: req.user?.id,
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
 * /api/api-keys/{keyId}/revoke:
 *   put:
 *     summary: Revoke an API key
 *     description: |
 *       Revoke an API key to prevent further use. Revoked keys can be reactivated later
 *       if needed. This immediately stops the key from working for lead uploads.
 *
 *       Use this when:
 *       - A key might be compromised
 *       - You want to temporarily disable access
 *       - Switching to a new key
 *       - An integration is no longer needed
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
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
 *                 example: "Key potentially compromised"
 *           examples:
 *             security_concern:
 *               summary: Security-related revocation
 *               value:
 *                 reason: "Key potentially compromised"
 *             no_longer_needed:
 *               summary: Key no longer needed
 *               value:
 *                 reason: "Integration discontinued"
 *             switching_keys:
 *               summary: Switching to new key
 *               value:
 *                 reason: "Upgrading to new production key"
 *     responses:
 *       200:
 *         description: API key revoked successfully
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
 *                   example: "API key revoked successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 1
 *                     key_name:
 *                       type: string
 *                       example: "Production Upload Key"
 *                     key_prefix:
 *                       type: string
 *                       example: "sk_a1b2c3d4"
 *                     revoked_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-01-26T15:30:00Z"
 *       400:
 *         description: Bad request - Key not found or already revoked
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
 *             examples:
 *               not_found:
 *                 summary: API key not found
 *                 value:
 *                   success: false
 *                   message: "API key not found or already revoked"
 *               invalid_id:
 *                 summary: Invalid key ID
 *                 value:
 *                   success: false
 *                   message: "Invalid key ID"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.put('/:keyId/revoke', authenticate, authorize(['supplier']), validate(revokeApiKeySchema), async (req, res) => {
    try {
        const supplierId = req.user.id;
        const keyId = parseInt(req.params.keyId);
        const { reason } = req.body;

        if (isNaN(keyId) || keyId < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid key ID'
            });
        }

        const revokedKey = await ApiKeys.revokeApiKey(keyId, supplierId, req.user.id, reason);

        logger.info('API key revoked', {
            keyId,
            supplierId,
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

        logger.error('Revoke API key error', {
            error: error.message,
            keyId: req.params.keyId,
            supplierId: req.user?.id,
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
 * /api/api-keys/{keyId}/reactivate:
 *   put:
 *     summary: Reactivate a revoked API key
 *     description: |
 *       Reactivate a previously revoked API key. The key will immediately
 *       become usable again for lead uploads with the same API key value.
 *
 *       This is useful when:
 *       - A key was temporarily revoked
 *       - The security concern has been resolved
 *       - You want to restore access quickly
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
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
 *                   example: "API key reactivated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 1
 *                     key_name:
 *                       type: string
 *                       example: "Production Upload Key"
 *                     key_prefix:
 *                       type: string
 *                       example: "sk_a1b2c3d4"
 *                     reactivated_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-01-26T16:00:00Z"
 *       400:
 *         description: Bad request - Key not found or already active
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
 *             examples:
 *               not_found:
 *                 summary: API key not found
 *                 value:
 *                   success: false
 *                   message: "API key not found or already active"
 *               invalid_id:
 *                 summary: Invalid key ID
 *                 value:
 *                   success: false
 *                   message: "Invalid key ID"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.put('/:keyId/reactivate', authenticate, authorize(['supplier']), async (req, res) => {
    try {
        const supplierId = req.user.id;
        const keyId = parseInt(req.params.keyId);

        if (isNaN(keyId) || keyId < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid key ID'
            });
        }

        const reactivatedKey = await ApiKeys.reactivateApiKey(keyId, supplierId);

        logger.info('API key reactivated', {
            keyId,
            supplierId,
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
            note: 'The API key is now active and can be used for lead uploads'
        });
    } catch (error) {
        if (error.message.includes('not found') || error.message.includes('already active')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        logger.error('Reactivate API key error', {
            error: error.message,
            keyId: req.params.keyId,
            supplierId: req.user?.id,
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
 * /api/api-keys/{keyId}:
 *   delete:
 *     summary: Delete an API key permanently
 *     description: |
 *       Permanently delete an API key. This action cannot be undone.
 *       The key will be completely removed from the system.
 *
 *       ⚠️  **WARNING**: This is permanent! Consider revoking instead if you might need it again.
 *
 *       Use permanent deletion when:
 *       - You're absolutely sure the key won't be needed
 *       - Cleaning up old/unused keys
 *       - The key was created by mistake
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
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
 *                   example: "API key deleted permanently"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 1
 *                     key_name:
 *                       type: string
 *                       example: "Old Development Key"
 *                     key_prefix:
 *                       type: string
 *                       example: "sk_x9y8z7w6"
 *                 warning:
 *                   type: string
 *                   example: "This action cannot be undone. The API key has been permanently deleted."
 *       400:
 *         description: Bad request - Key not found
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
 *             examples:
 *               not_found:
 *                 summary: API key not found
 *                 value:
 *                   success: false
 *                   message: "API key not found"
 *               invalid_id:
 *                 summary: Invalid key ID
 *                 value:
 *                   success: false
 *                   message: "Invalid key ID"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Only suppliers can access this endpoint
 *       500:
 *         description: Internal server error
 */
router.delete('/:keyId', authenticate, authorize(['supplier']), async (req, res) => {
    try {
        const supplierId = req.user.id;
        const keyId = parseInt(req.params.keyId);

        if (isNaN(keyId) || keyId < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid key ID'
            });
        }

        const deletedKey = await ApiKeys.deleteApiKey(keyId, supplierId);

        logger.info('API key deleted permanently', {
            keyId,
            supplierId,
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

        logger.error('Delete API key error', {
            error: error.message,
            keyId: req.params.keyId,
            supplierId: req.user?.id,
            stack: error.stack
        });
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting API key'
        });
    }
});

export default router