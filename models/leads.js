// models/leads.js
import { db } from '#config';
import { logger } from '#utils';

class Leads {
    static FRESHNESS_DAYS = 30;

    static requiredFields = ['phone', 'email', 'address', 'type'];

    static typeValidations = {
        solar_panel: lead => lead.roof_orientation?.toLowerCase().includes('south'),
        insulation: lead => parseInt(lead.home_age) > 15,
        ev_charger: lead => !!lead.garage || !!lead.parking,
        insurance: lead => !!lead.zip || !!lead.city
    };

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
            `INSERT INTO leads (client_id, email, phone, address, type, score, other_fields, upload_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
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

    static async processLeads(uploadId, leads, clientId, threshold = 70) {
        let client;
        try {
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
                        errors: ['Missing or invalid required fields']
                    });
                    processedCount++;
                    continue;
                }

                const isDup = duplicatesSet.has(key);
                const score = this.scoreLead(lead, isDup);

                processedResults.push({
                    lead_data: lead,
                    status: isDup ? 'duplicate' : (score >= threshold ? 'valid' : 'below_threshold'),
                    score,
                    errors: isDup ? ['Duplicate lead found'] : []
                });

                if (score >= threshold && !isDup) {
                    const { core, other } = this.extractFields({ ...lead, score, upload_id: uploadId });
                    validLeads.push({ ...core, other_fields: other });
                    validCount++;
                }

                processedCount++;

                // Update progress every 100 leads
                if (processedCount % 100 === 0) {
                    await this.updateUploadStatus(uploadId, 'processing', {
                        processed_leads: processedCount,
                        valid_leads: validCount
                    });
                }
            }

            // Batch insert valid leads
            if (validLeads.length > 0) {
                const values = [];
                const params = [];

                validLeads.forEach((lead, i) => {
                    const baseIndex = i * 8;
                    values.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8})`);
                    params.push(
                        lead.client_id,
                        lead.email,
                        lead.phone,
                        lead.address,
                        lead.type,
                        lead.score,
                        lead.other_fields,
                        lead.upload_id
                    );
                });

                await client.query(
                    `INSERT INTO leads (client_id, email, phone, address, type, score, other_fields, upload_id)
                     VALUES ${values.join(', ')}`,
                    params
                );
            }

            await client.query('COMMIT');

            // Update final status
            await this.updateUploadStatus(uploadId, 'completed', {
                total_leads: leads.length,
                processed_leads: processedCount,
                valid_leads: validCount
            });

            logger.info(`Successfully processed upload ${uploadId}`, {
                total: leads.length,
                processed: processedCount,
                valid: validCount
            });

            return {
                success: true,
                total: leads.length,
                processed: processedCount,
                valid: validCount
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

    static async updateClientStatus({ leadId, clientId, status }) {
        const allowedStatuses = ['invalid', 'sold', 'contacted', 'rejected'];

        if (!allowedStatuses.includes(status)) {
            throw new Error(`Status '${status}' is not allowed.`);
        }

        const { rowCount } = await db.query(
            `UPDATE leads
             SET client_status = $1
             WHERE id = $2 AND client_id = $3`,
            [status, leadId, clientId]
        );

        if (rowCount === 0) {
            throw new Error(`Lead not found or access denied.`);
        }

        return true;
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

    // Get upload statistics for a supplier
    static async getSupplierStats(supplierId, dateRange = 30) {
        const { rows } = await db.query(`
            SELECT 
                COUNT(*) as total_uploads,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_uploads,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_uploads,
                SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) as pending_uploads,
                SUM(total_leads) as total_leads_uploaded,
                SUM(valid_leads) as total_valid_leads
            FROM lead_uploads
            WHERE supplier_id = $1 
            AND uploaded_at >= NOW() - INTERVAL '${dateRange} days'
        `, [supplierId]);

        return rows[0];
    }

    // Get client statistics for uploads
    static async getClientStats(clientId, dateRange = 30) {
        const { rows } = await db.query(`
            SELECT 
                COUNT(DISTINCT lu.id) as total_uploads,
                COUNT(DISTINCT lu.supplier_id) as unique_suppliers,
                SUM(lu.valid_leads) as total_leads_received,
                AVG(l.score) as average_lead_score
            FROM lead_uploads lu
            LEFT JOIN leads l ON l.client_id = lu.client_id AND l.upload_id = lu.id
            WHERE lu.client_id = $1 
            AND lu.uploaded_at >= NOW() - INTERVAL '${dateRange} days'
            AND lu.status = 'completed'
        `, [clientId]);

        return rows[0];
    }
}

export default Leads;