import {pool} from '#config';
import {logger} from '#utils';
import crypto from 'crypto';

class RefreshToken {
    // Create a new refresh token
    static async create(userId, userAgent, ipAddress) {
        try {
            const token = crypto.randomBytes(40).toString('hex');
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 14); // 14 days

            const deviceInfo = {
                userAgent,
                createdAt: new Date()
            };

            const query = `
                INSERT INTO refresh_tokens (user_id, token, expires_at, device_info, ip_address)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, token, expires_at
            `;

            const result = await pool.query(query, [
                userId,
                token,
                expiresAt,
                JSON.stringify(deviceInfo),
                ipAddress
            ]);

            return result.rows[0];
        } catch (error) {
            logger.error('Error creating refresh token', error);
            throw error;
        }
    }

    // Find token by value
    static async findByToken(token) {
        try {
            const query = `
                SELECT rt.*, u.id as user_id, u.fullname, u.email, u.role, u.is_active
                FROM refresh_tokens rt
                         JOIN users u ON rt.user_id = u.id
                WHERE rt.token = $1
                  AND rt.expires_at > CURRENT_TIMESTAMP
            `;

            const result = await pool.query(query, [token]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error finding refresh token', error);
            throw error;
        }
    }

    // Delete token
    static async delete(token) {
        try {
            const query = `
                DELETE
                FROM refresh_tokens
                WHERE token = $1
                RETURNING id
            `;

            const result = await pool.query(query, [token]);
            return result.rowCount > 0;
        } catch (error) {
            logger.error('Error deleting refresh token', error);
            throw error;
        }
    }

    // Delete all tokens for user
    static async deleteAllForUser(userId) {
        try {
            const query = `
                DELETE
                FROM refresh_tokens
                WHERE user_id = $1
                RETURNING id
            `;

            const result = await pool.query(query, [userId]);
            return result.rowCount;
        } catch (error) {
            logger.error('Error deleting all refresh tokens for user', error);
            throw error;
        }
    }

    // Prune expired tokens (called periodically)
    static async pruneExpired() {
        try {
            const query = `
                DELETE
                FROM refresh_tokens
                WHERE expires_at < CURRENT_TIMESTAMP
                RETURNING id
            `;

            const result = await pool.query(query);
            return result.rowCount;
        } catch (error) {
            logger.error('Error pruning expired refresh tokens', error);
            throw error;
        }
    }
}

export default RefreshToken;