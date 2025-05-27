// models/clientSettings.js - Simplified without supplier relationships
import { db } from '#config';
import { logger } from '#utils';

class ClientSettings {
    // Get client's threshold and settings
    static async getClientSettings(clientId) {
        try {
            const { rows } = await db.query(`
                SELECT
                    cs.min_lead_score,
                    cs.auto_accept_leads,
                    cs.notification_email,
                    cs.created_at,
                    cs.updated_at,
                    u.fullname as client_name,
                    u.email as client_email
                FROM client_settings cs
                         JOIN users u ON u.id = cs.client_id
                WHERE cs.client_id = $1
            `, [clientId]);

            if (rows.length === 0) {
                // Create default settings if none exist
                return await this.createDefaultSettings(clientId);
            }

            return rows[0];
        } catch (error) {
            logger.error('Error getting client settings', error);
            throw error;
        }
    }

    // Create default settings for a client
    static async createDefaultSettings(clientId) {
        try {
            const { rows } = await db.query(`
                INSERT INTO client_settings (client_id, min_lead_score, auto_accept_leads, notification_email)
                VALUES ($1, 70, true, true)
                ON CONFLICT (client_id) DO UPDATE SET
                    updated_at = CURRENT_TIMESTAMP
                RETURNING *
            `, [clientId]);

            return rows[0];
        } catch (error) {
            logger.error('Error creating default client settings', error);
            throw error;
        }
    }

    // Update client settings
    static async updateSettings(clientId, settings) {
        try {
            const setClauses = [];
            const values = [clientId];
            let paramCounter = 2;

            // Build dynamic update query
            if (settings.min_lead_score !== undefined) {
                setClauses.push(`min_lead_score = $${paramCounter}`);
                values.push(settings.min_lead_score);
                paramCounter++;
            }

            if (settings.auto_accept_leads !== undefined) {
                setClauses.push(`auto_accept_leads = $${paramCounter}`);
                values.push(settings.auto_accept_leads);
                paramCounter++;
            }

            if (settings.notification_email !== undefined) {
                setClauses.push(`notification_email = $${paramCounter}`);
                values.push(settings.notification_email);
                paramCounter++;
            }

            if (setClauses.length === 0) {
                throw new Error('No valid settings to update');
            }

            const query = `
                UPDATE client_settings
                SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
                WHERE client_id = $1
                RETURNING *
            `;

            const { rows } = await db.query(query, values);

            if (rows.length === 0) {
                throw new Error('Client settings not found');
            }

            return rows[0];
        } catch (error) {
            logger.error('Error updating client settings', error);
            throw error;
        }
    }

    // Get client statistics including threshold usage
    static async getClientStats(clientId, dateRange = 30) {
        try {
            const { rows } = await db.query(`
                SELECT
                    cs.min_lead_score as current_threshold,
                    COUNT(DISTINCT lu.id) as total_uploads,
                    COUNT(DISTINCT lu.supplier_id) as unique_suppliers,
                    SUM(lu.total_leads) as total_leads_received,
                    SUM(lu.valid_leads) as leads_above_threshold,
                    SUM(CASE WHEN l.score >= cs.min_lead_score THEN 1 ELSE 0 END) as leads_meeting_current_threshold,
                    AVG(l.score) as average_lead_score,
                    COUNT(DISTINCT CASE WHEN l.score >= cs.min_lead_score THEN l.id END) as leads_would_accept_now
                FROM client_settings cs
                         LEFT JOIN lead_uploads lu ON lu.client_id = cs.client_id
                    AND lu.uploaded_at >= NOW() - INTERVAL '${dateRange} days'
                    AND lu.status = 'completed'
                         LEFT JOIN leads l ON l.client_id = cs.client_id
                    AND l.created_at >= NOW() - INTERVAL '${dateRange} days'
                WHERE cs.client_id = $1
                GROUP BY cs.client_id, cs.min_lead_score
            `, [clientId]);

            return rows[0] || {
                current_threshold: 70,
                total_uploads: 0,
                unique_suppliers: 0,
                total_leads_received: 0,
                leads_above_threshold: 0,
                leads_meeting_current_threshold: 0,
                average_lead_score: 0,
                leads_would_accept_now: 0
            };
        } catch (error) {
            logger.error('Error getting client stats', error);
            throw error;
        }
    }
}

export default ClientSettings;