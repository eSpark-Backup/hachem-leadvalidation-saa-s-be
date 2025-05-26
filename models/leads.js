// models/leads.js - Updated with client feedback functionality
import { db } from '#config';
import { logger } from '#utils';
import ClientSettings from './clientSettings.js';

class Leads {
    static FRESHNESS_DAYS = 30;

    static requiredFields = ['phone', 'email', 'address', 'type'];

    static typeValidations = {
        solar_panel: lead => lead.roof_orientation?.toLowerCase().includes('south'),
        insulation: lead => parseInt(lead.home_age) > 15,
        ev_charger: lead => !!lead.garage || !!lead.parking,
        insurance: lead => !!lead.zip || !!lead.city
    };

    // Valid client status values
    static validClientStatuses = [
        'pending', 'contacted', 'sold', 'invalid', 'duplicate',
        'low_quality', 'not_interested', 'rejected'
    ];

    static scoreLead(lead, isDuplicate) {
        let score = 0;

        const hasRequired = this.requiredFields.every(f => lead[f] && lead[f].toString().trim() !== '');
        if (hasRequired) score += 20;

        // Validate phone format - more flexible regex
        if (/^\+?[\d\s\-\(\)]{10,15}$/.test(lead.phone?.replace(/\s/g, ''))) score += 30;

        if (!isDuplicate) score += 20;

        // Add type-specific bonus score
        if (this.validateByType(lead)) score += 30;

        return score;
    }

    static validateByType(lead) {
        const validator = this.typeValidations[lead.type?.toLowerCase()];
        return validator ? validator(lead) : true;
    }

    static async isDuplicate(lead) {
        const { rowCount } = await db.query(
            `SELECT 1 FROM leads
             WHERE client_id = $1 AND email = $2 AND phone = $3 AND type = $4
               AND created_at >= NOW() - INTERVAL '${this.FRESHNESS_DAYS} days'
             LIMIT 1`,
            [lead.client_id, lead.email, lead.phone, lead.type]
        );
        return rowCount > 0;
    }

    static extractFields(lead) {
        const core = {};
        const other = {};
        for (const [key, value] of Object.entries(lead)) {
            if (this.requiredFields.includes(key) || key === 'score' || key === 'client_id' || key === 'upload_id') {
                core[key] = value;
            } else {
                other[key] = value;
            }
        }
        return { core, other };
    }

    static async insertLead(lead, score, uploadId) {
        const { core, other } = this.extractFields({ ...lead, upload_id: uploadId });
        const { rows } = await db.query(
            `INSERT INTO leads (client_id, email, phone, address, type, score, other_fields, upload_id, client_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING id`,
            [core.client_id, core.email, core.phone, core.address, core.type, score, other, uploadId]
        );
        return rows[0].id;
    }

    static async updateUploadStatus(uploadId, status, updates = {}) {
        const setClause = Object.keys(updates).map((key, index) => `${key} = $${index + 3}`).join(', ');
        const values = [uploadId, status, ...Object.values(updates)];

        let query = `UPDATE lead_uploads SET status = $2`;
        if (setClause) {
            query += `, ${setClause}`;
        }
        if (status === 'completed' || status === 'failed') {
            query += `, completed_at = CURRENT_TIMESTAMP`;
        }
        query += ` WHERE id = $1`;

        await db.query(query, values);
    }

    // Updated to set default client_status as 'pending'
    static async processLeads(uploadId, leads, clientId, supplierId = null) {
        let client;
        try {
            // Get client's threshold from their settings
            const clientSettings = await ClientSettings.getClientSettings(clientId);
            const threshold = clientSettings.min_lead_score || 70;

            logger.info(`Processing leads with client threshold: ${threshold}`, {
                uploadId,
                clientId,
                threshold,
                totalLeads: leads.length
            });

            // Update status to processing
            await this.updateUploadStatus(uploadId, 'processing', {
                total_leads: leads.length
            });

            leads = leads.map(lead => ({ ...lead, client_id: clientId }));

            // Get duplicates in bulk
            const duplicatesSet = await this.findDuplicatesBulk(leads);

            const validLeads = [];
            const processedResults = [];
            let processedCount = 0;
            let validCount = 0;
            let aboveThresholdCount = 0;

            client = await db.pool.connect();
            await client.query('BEGIN');

            for (const lead of leads) {
                const key = `${lead.email}|${lead.phone}|${lead.type}|${lead.client_id}`;

                // Check required fields
                const hasRequired = this.requiredFields.every(f =>
                    lead[f] && lead[f].toString().trim() !== '' &&
                    !['n/a', 'test', 'null', 'undefined'].includes(lead[f].toString().toLowerCase())
                );

                if (!hasRequired) {
                    processedResults.push({
                        lead_data: lead,
                        status: 'invalid',
                        score: 0,
                        errors: ['Missing or invalid required fields'],
                        meets_threshold: false
                    });
                    processedCount++;
                    continue;
                }

                const isDup = duplicatesSet.has(key);
                const score = this.scoreLead(lead, isDup);
                const meetsThreshold = score >= threshold;

                let status;
                if (isDup) {
                    status = 'duplicate';
                } else if (score < threshold) {
                    status = 'below_threshold';
                } else {
                    status = 'valid';
                    aboveThresholdCount++;
                }

                processedResults.push({
                    lead_data: lead,
                    status,
                    score,
                    errors: isDup ? ['Duplicate lead found'] : [],
                    meets_threshold: meetsThreshold
                });

                // Always insert the lead with its score, regardless of threshold
                // Set client_status to 'pending' by default
                if (!isDup) {
                    const { core, other } = this.extractFields({ ...lead, score, upload_id: uploadId });
                    validLeads.push({ ...core, other_fields: other, client_status: 'pending' });
                    validCount++;
                }

                processedCount++;

                // Update progress every 100 leads
                if (processedCount % 100 === 0) {
                    await this.updateUploadStatus(uploadId, 'processing', {
                        processed_leads: processedCount,
                        valid_leads: validCount,
                        leads_above_threshold: aboveThresholdCount
                    });
                }
            }

            // Batch insert valid (non-duplicate) leads
            if (validLeads.length > 0) {
                const values = [];
                const params = [];

                validLeads.forEach((lead, i) => {
                    const baseIndex = i * 9;
                    values.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9})`);
                    params.push(
                        lead.client_id,
                        lead.email,
                        lead.phone,
                        lead.address,
                        lead.type,
                        lead.score,
                        lead.other_fields,
                        lead.upload_id,
                        lead.client_status
                    );
                });

                await client.query(
                    `INSERT INTO leads (client_id, email, phone, address, type, score, other_fields, upload_id, client_status)
                    VALUES ${values.join(', ')}`,
                    params
                );
            }

            await client.query('COMMIT');

            // Update final status
            await this.updateUploadStatus(uploadId, 'completed', {
                total_leads: leads.length,
                processed_leads: processedCount,
                valid_leads: validCount,
                leads_above_threshold: aboveThresholdCount
            });

            logger.info(`Successfully processed upload ${uploadId}`, {
                total: leads.length,
                processed: processedCount,
                valid: validCount,
                aboveThreshold: aboveThresholdCount,
                clientThreshold: threshold
            });

            return {
                success: true,
                total: leads.length,
                processed: processedCount,
                valid: validCount,
                above_threshold: aboveThresholdCount,
                client_threshold: threshold
            };

        } catch (error) {
            if (client) {
                await client.query('ROLLBACK');
            }

            logger.error(`Failed to process upload ${uploadId}`, error);

            await this.updateUploadStatus(uploadId, 'failed', {
                error_message: error.message
            });

            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Update client status for a lead
    static async updateClientStatus({ leadId, clientId, status }) {
        if (!this.validClientStatuses.includes(status)) {
            throw new Error(`Status '${status}' is not allowed. Valid statuses: ${this.validClientStatuses.join(', ')}`);
        }

        const { rowCount } = await db.query(
            `UPDATE leads
             SET client_status = $1, client_updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND client_id = $3`,
            [status, leadId, clientId]
        );

        if (rowCount === 0) {
            throw new Error(`Lead not found or access denied.`);
        }

        return true;
    }

    // Get leads that meet client's current threshold with status info
    static async getLeadsForClient(clientId, options = {}) {
        try {
            const {
                page = 1,
                limit = 50,
                status = 'all', // 'all', 'above_threshold', 'below_threshold'
                client_status = null, // Filter by client status
                uploadId = null
            } = options;

            // Get client's current threshold
            const clientSettings = await ClientSettings.getClientSettings(clientId);
            const threshold = clientSettings.min_lead_score || 70;

            const offset = (page - 1) * limit;
            let whereClause = 'WHERE l.client_id = $1';
            const queryParams = [clientId];
            let paramCounter = 2;

            if (uploadId) {
                whereClause += ` AND l.upload_id = $${paramCounter}`;
                queryParams.push(uploadId);
                paramCounter++;
            }

            if (status === 'above_threshold') {
                whereClause += ` AND l.score >= $${paramCounter}`;
                queryParams.push(threshold);
                paramCounter++;
            } else if (status === 'below_threshold') {
                whereClause += ` AND l.score < $${paramCounter}`;
                queryParams.push(threshold);
                paramCounter++;
            }

            if (client_status) {
                whereClause += ` AND l.client_status = $${paramCounter}`;
                queryParams.push(client_status);
                paramCounter++;
            }

            const query = `
                SELECT 
                    l.*,
                    CASE WHEN l.score >= $${paramCounter} THEN true ELSE false END as meets_current_threshold,
                    u.fullname as supplier_name,
                    u.company as supplier_company,
                    lu.supplier_id,
                    l.client_status
                FROM leads l
                LEFT JOIN lead_uploads lu ON lu.id = l.upload_id
                LEFT JOIN users u ON u.id = lu.supplier_id
                ${whereClause}
                ORDER BY l.created_at DESC
                LIMIT $${paramCounter + 1} OFFSET $${paramCounter + 2}
            `;

            queryParams.push(threshold, limit, offset);

            const { rows } = await db.query(query, queryParams);

            return {
                leads: rows,
                client_threshold: threshold,
                pagination: {
                    page,
                    limit,
                    total: rows.length
                }
            };
        } catch (error) {
            logger.error('Error getting leads for client', error);
            throw error;
        }
    }

    // Rest of the methods remain the same...
    static async archiveOldLeads() {
        try {
            await db.query('BEGIN');

            await db.query(`
                INSERT INTO leads_archive (client_id, email, phone, address, type, score, other_fields, original_created_at)
                SELECT client_id, email, phone, address, type, score, other_fields, created_at
                FROM leads
                WHERE created_at < NOW() - INTERVAL '${this.FRESHNESS_DAYS} days'
            `);

            const { rowCount } = await db.query(`
                DELETE FROM leads
                WHERE created_at < NOW() - INTERVAL '${this.FRESHNESS_DAYS} days'
            `);

            await db.query('COMMIT');
            logger.info(`Archived ${rowCount} old leads.`);
        } catch (err) {
            await db.query('ROLLBACK');
            logger.error('Archiving failed:', err);
        }
    }

    static async findDuplicatesBulk(leads) {
        if (leads.length === 0) return new Set();

        const keys = leads.map(lead => [
            lead.email,
            lead.phone,
            lead.type,
            lead.client_id
        ]);

        // Generate VALUES string
        const valuesClause = keys
            .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
            .join(', ');

        const flatParams = keys.flat();

        const query = `
            SELECT email, phone, type, client_id
            FROM leads
            WHERE created_at >= NOW() - INTERVAL '${this.FRESHNESS_DAYS} days'
              AND (email, phone, type, client_id) IN (${valuesClause})
        `;

        const { rows } = await db.query(query, flatParams);

        // Convert duplicates into a Set of stringified keys
        return new Set(rows.map(row =>
            `${row.email}|${row.phone}|${row.type}|${row.client_id}`
        ));
    }

    // Updated supplier stats to not include threshold info
    static async getSupplierStats(supplierId, dateRange = 30) {
        const { rows } = await db.query(`
            SELECT 
                COUNT(*) as total_uploads,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_uploads,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_uploads,
                SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) as pending_uploads,
                SUM(total_leads) as total_leads_uploaded,
                SUM(valid_leads) as total_valid_leads,
                COUNT(DISTINCT client_id) as unique_clients
            FROM lead_uploads
            WHERE supplier_id = $1 
            AND uploaded_at >= NOW() - INTERVAL '${dateRange} days'
        `, [supplierId]);

        return rows[0];
    }

    // Updated client stats - moved to ClientSettings model
    static async getClientStats(clientId, dateRange = 30) {
        return await ClientSettings.getClientStats(clientId, dateRange);
    }

    // Get client feedback statistics for suppliers
    static async getSupplierFeedbackStats(supplierId, dateRange = 30) {
        try {
            const { rows } = await db.query(`
                SELECT 
                    COUNT(*) as total_leads,
                    SUM(CASE WHEN l.client_status = 'contacted' THEN 1 ELSE 0 END) as contacted,
                    SUM(CASE WHEN l.client_status = 'sold' THEN 1 ELSE 0 END) as sold,
                    SUM(CASE WHEN l.client_status = 'invalid' THEN 1 ELSE 0 END) as invalid,
                    SUM(CASE WHEN l.client_status = 'duplicate' THEN 1 ELSE 0 END) as duplicate,
                    SUM(CASE WHEN l.client_status = 'low_quality' THEN 1 ELSE 0 END) as low_quality,
                    SUM(CASE WHEN l.client_status = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
                    SUM(CASE WHEN l.client_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                    SUM(CASE WHEN l.client_status = 'pending' OR l.client_status IS NULL THEN 1 ELSE 0 END) as pending,
                    AVG(l.score) as average_score
                FROM leads l
                JOIN lead_uploads lu ON lu.id = l.upload_id
                WHERE lu.supplier_id = $1 
                AND l.created_at >= NOW() - INTERVAL '${dateRange} days'
            `, [supplierId]);

            const stats = rows[0];

            // Calculate rates
            const totalLeads = parseInt(stats.total_leads) || 0;
            const soldLeads = parseInt(stats.sold) || 0;
            const invalidLeads = parseInt(stats.invalid) || 0;
            const duplicateLeads = parseInt(stats.duplicate) || 0;

            return {
                total_leads: totalLeads,
                contacted: parseInt(stats.contacted) || 0,
                sold: soldLeads,
                invalid: invalidLeads,
                duplicate: duplicateLeads,
                low_quality: parseInt(stats.low_quality) || 0,
                not_interested: parseInt(stats.not_interested) || 0,
                rejected: parseInt(stats.rejected) || 0,
                pending: parseInt(stats.pending) || 0,
                average_score: stats.average_score ? parseFloat(stats.average_score).toFixed(1) : 0,
                conversion_rate: totalLeads > 0 ? ((soldLeads / totalLeads) * 100).toFixed(1) : 0,
                quality_issues_rate: totalLeads > 0 ? (((invalidLeads + duplicateLeads) / totalLeads) * 100).toFixed(1) : 0
            };
        } catch (error) {
            logger.error('Error getting supplier feedback stats', error);
            throw error;
        }
    }
}

export default Leads;