import {pool as db} from '#config';

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

        const hasRequired = this.requiredFields.every(f => lead[f]);
        if (hasRequired) score += 20;

        if (/^\+?\d{10,15}$/.test(lead.phone)) score += 30;
        if (!isDuplicate) score += 20;

        // Optional: add type-specific bonus score
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
            if (this.requiredFields.includes(key) || key === 'score' || key === 'client_id') {
                core[key] = value;
            } else {
                other[key] = value;
            }
        }
        return { core, other };
    }

    static async insertLead(lead, score) {
        const { core, other } = this.extractFields(lead);
        await db.query(
            `INSERT INTO leads (client_id, email, phone, address, type, score, other_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [core.client_id, core.email, core.phone, core.address, core.type, score, other]
        );
    }

    static async processLeads(leads, clientId, threshold = 70) {
        leads = leads.map(lead => ({ ...lead, client_id: clientId }));

        const duplicatesSet = await this.findDuplicatesBulk(leads);

        const validLeads = [];

        for (const lead of leads) {
            const key = `${lead.email}|${lead.phone}|${lead.type}|${lead.client_id}`;

            const hasRequired = this.requiredFields.every(f => lead[f]);
            if (!hasRequired) continue;

            const isDup = duplicatesSet.has(key);
            const score = this.scoreLead(lead, isDup);

            if (score >= threshold) {
                const { core, other } = this.extractFields({ ...lead, score });
                validLeads.push({ ...core, other_fields: other });
            }
        }

        if (validLeads.length === 0) return;

        // Batch insert
        const values = [];
        const params = [];

        validLeads.forEach((lead, i) => {
            const baseIndex = i * 7;
            values.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`);
            params.push(
                lead.client_id,
                lead.email,
                lead.phone,
                lead.address,
                lead.type,
                lead.score,
                lead.other_fields
            );
        });

        await db.query(
            `
    INSERT INTO leads (client_id, email, phone, address, type, score, other_fields)
    VALUES ${values.join(', ')}
    `,
            params
        );
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
            console.log(`Archived ${rowCount} old leads.`);
        } catch (err) {
            await db.query('ROLLBACK');
            console.error('Archiving failed:', err);
        }
    }

    static async updateClientStatus({ leadId, clientId, status }) {
        const allowedStatuses = ['invalid', 'sold', 'contacted', 'rejected']; // optional enforcement

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

}

module.exports = Leads;
