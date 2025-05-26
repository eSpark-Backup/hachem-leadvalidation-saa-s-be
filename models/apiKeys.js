// models/apiKeys.js
import {db} from '#config';
import {logger} from '#utils';
import crypto from 'crypto';

class ApiKeys {
    // Generate a new API key
    static generateApiKey() {
        // Generate 64 character API key
        const key = crypto.randomBytes(32).toString('hex');
        const prefix = key.substring(0, 8);

        return {
            apiKey: `sk_${key}`,
            prefix: `sk_${prefix}`
        };
    }

    // Create a new API key for a supplier
    static async createApiKey(supplierId, keyName, createdBy = null) {
        try {
            const {apiKey, prefix} = this.generateApiKey();

            const {rows} = await db.query(`
                INSERT INTO api_keys (supplier_id, key_name, api_key, key_prefix, created_by)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, key_name, key_prefix, is_active, created_at
            `, [supplierId, keyName, apiKey, prefix, createdBy || supplierId]);

            const newKey = rows[0];

            logger.info('API key created', {
                keyId: newKey.id,
                supplierId,
                keyName,
                prefix
            });

            return {
                ...newKey,
                api_key: apiKey // Return full key only on creation
            };
        } catch (error) {
            if (error.code === '23505') { // Unique constraint violation
                throw new Error('API key name already exists for this supplier');
            }
            logger.error('Error creating API key', error);
            throw error;
        }
    }

    // Authenticate using API key
    static async authenticateApiKey(apiKey, ipAddress = null) {
        try {
            // Query for active API key and get supplier info
            const {rows} = await db.query(`
                SELECT ak.id,
                       ak.supplier_id,
                       ak.key_name,
                       ak.usage_count,
                       u.id        as user_id,
                       u.fullname,
                       u.email,
                       u.role,
                       u.is_active as user_active
                FROM api_keys ak
                         JOIN users u ON u.id = ak.supplier_id
                WHERE ak.api_key = $1
                  AND ak.is_active = true
                  AND u.is_active = true
                  AND u.role = 'supplier'
            `, [apiKey]);

            if (rows.length === 0) {
                return null; // Invalid or inactive key
            }

            const keyData = rows[0];

            // Update last used info
            await db.query(`
                UPDATE api_keys
                SET last_used_at = CURRENT_TIMESTAMP,
                    last_used_ip = $1,
                    usage_count  = usage_count + 1
                WHERE id = $2
            `, [ipAddress, keyData.id]);

            logger.debug('API key authentication successful', {
                keyId: keyData.id,
                supplierId: keyData.supplier_id,
                keyName: keyData.key_name,
                ipAddress
            });

            return {
                id: keyData.user_id,
                fullname: keyData.fullname,
                email: keyData.email,
                role: keyData.role,
                supplierId: keyData.supplier_id,
                keyId: keyData.id,
                keyName: keyData.key_name
            };
        } catch (error) {
            logger.error('Error authenticating API key', error);
            throw error;
        }
    }

    // Get all API keys for a supplier
    static async getSupplierApiKeys(supplierId) {
        try {
            const {rows} = await db.query(`
                SELECT id,
                       key_name,
                       key_prefix,
                       is_active,
                       last_used_at,
                       last_used_ip,
                       usage_count,
                       created_at,
                       revoked_at,
                       revoke_reason
                FROM api_keys
                WHERE supplier_id = $1
                ORDER BY created_at DESC
            `, [supplierId]);

            return rows;
        } catch (error) {
            logger.error('Error getting supplier API keys', error);
            throw error;
        }
    }

    // Revoke an API key
    static async revokeApiKey(keyId, supplierId, revokedBy = null, reason = null) {
        try {
            const {rows} = await db.query(`
                UPDATE api_keys
                SET is_active     = false,
                    revoked_at    = CURRENT_TIMESTAMP,
                    revoked_by    = $1,
                    revoke_reason = $2
                WHERE id = $3
                  AND supplier_id = $4
                  AND is_active = true
                RETURNING id, key_name, key_prefix
            `, [revokedBy || supplierId, reason, keyId, supplierId]);

            if (rows.length === 0) {
                throw new Error('API key not found or already revoked');
            }

            const revokedKey = rows[0];

            logger.info('API key revoked', {
                keyId: revokedKey.id,
                keyName: revokedKey.key_name,
                supplierId,
                reason
            });

            return revokedKey;
        } catch (error) {
            logger.error('Error revoking API key', error);
            throw error;
        }
    }

    // Reactivate a revoked API key
    static async reactivateApiKey(keyId, supplierId) {
        try {
            const {rows} = await db.query(`
                UPDATE api_keys
                SET is_active     = true,
                    revoked_at    = NULL,
                    revoked_by    = NULL,
                    revoke_reason = NULL
                WHERE id = $1
                  AND supplier_id = $2
                  AND is_active = false
                RETURNING id, key_name, key_prefix
            `, [keyId, supplierId]);

            if (rows.length === 0) {
                throw new Error('API key not found or already active');
            }

            const reactivatedKey = rows[0];

            logger.info('API key reactivated', {
                keyId: reactivatedKey.id,
                keyName: reactivatedKey.key_name,
                supplierId
            });

            return reactivatedKey;
        } catch (error) {
            logger.error('Error reactivating API key', error);
            throw error;
        }
    }

    // Delete an API key permanently
    static async deleteApiKey(keyId, supplierId) {
        try {
            const {rows} = await db.query(`
                DELETE
                FROM api_keys
                WHERE id = $1
                  AND supplier_id = $2
                RETURNING id, key_name, key_prefix
            `, [keyId, supplierId]);

            if (rows.length === 0) {
                throw new Error('API key not found');
            }

            const deletedKey = rows[0];

            logger.info('API key deleted', {
                keyId: deletedKey.id,
                keyName: deletedKey.key_name,
                supplierId
            });

            return deletedKey;
        } catch (error) {
            logger.error('Error deleting API key', error);
            throw error;
        }
    }

    // Get API key usage statistics
    static async getApiKeyStats(supplierId, days = 30) {
        try {
            const {rows} = await db.query(`
                SELECT COUNT(*)                                           as total_keys,
                       SUM(CASE WHEN is_active = true THEN 1 ELSE 0 END)  as active_keys,
                       SUM(CASE WHEN is_active = false THEN 1 ELSE 0 END) as revoked_keys,
                       SUM(usage_count)                                   as total_usage,
                       MAX(last_used_at)                                  as last_activity
                FROM api_keys
                WHERE supplier_id = $1
            `, [supplierId]);

            const stats = rows[0];

            return {
                total_keys: parseInt(stats.total_keys) || 0,
                active_keys: parseInt(stats.active_keys) || 0,
                revoked_keys: parseInt(stats.revoked_keys) || 0,
                total_usage: parseInt(stats.total_usage) || 0,
                last_activity: stats.last_activity
            };
        } catch (error) {
            logger.error('Error getting API key stats', error);
            throw error;
        }
    }

    // Clean up old revoked keys (optional maintenance)
    static async cleanupOldKeys(daysOld = 90) {
        try {
            const {rowCount} = await db.query(`
                DELETE
                FROM api_keys
                WHERE is_active = false
                  AND revoked_at < NOW() - INTERVAL '${daysOld} days'
            `);

            logger.info(`Cleaned up ${rowCount} old revoked API keys`);
            return rowCount;
        } catch (error) {
            logger.error('Error cleaning up old API keys', error);
            throw error;
        }
    }
}

export default ApiKeys;