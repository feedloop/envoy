import { Pool } from 'pg';
import { Escalation, EscalationRepo, EscalationStatus } from './types';

export class PostgresEscalationRepo implements EscalationRepo {
    private pool: Pool;
    constructor(pool: Pool) {
        this.pool = pool;
    }

    async createEscalation(escalation: Omit<Escalation, 'id' | 'created_at' | 'updated_at' | 'status'>): Promise<Escalation> {
        const res = await this.pool.query(
            `INSERT INTO escalations (id, job_id, wait_id, "user", message, inputs, status, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', NOW(), NOW()) RETURNING *`,
            [escalation.job_id, escalation.wait_id, escalation.user, escalation.message, JSON.stringify(escalation.inputs)]
        );
        return this.rowToEscalation(res.rows[0]);
    }

    async getEscalation(id: string): Promise<Escalation> {
        const res = await this.pool.query(`SELECT * FROM escalations WHERE id = $1`, [id]);
        if (res.rows.length === 0) throw new Error(`Escalation ${id} not found`);
        return this.rowToEscalation(res.rows[0]);
    }

    async updateEscalation(id: string, updates: Partial<Escalation>): Promise<Escalation> {
        const fields = [];
        const values = [];
        let idx = 1;
        for (const [key, value] of Object.entries(updates)) {
            const quotedKey = key === 'user' ? '"user"' : key;
            fields.push(`${quotedKey} = $${idx}`);
            values.push(key === 'inputs' || key === 'response' ? JSON.stringify(value) : value);
            idx++;
        }
        values.push(id);
        const setClause = fields.join(', ');
        const res = await this.pool.query(
            `UPDATE escalations SET ${setClause}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
            values
        );
        if (res.rows.length === 0) throw new Error(`Escalation ${id} not found`);
        return this.rowToEscalation(res.rows[0]);
    }

    async listPendingEscalations(): Promise<Escalation[]> {
        const res = await this.pool.query(`SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at ASC`);
        return res.rows.map(this.rowToEscalation);
    }

    private rowToEscalation(row: any): Escalation {
        return {
            id: row.id,
            job_id: row.job_id,
            wait_id: row.wait_id,
            user: row.user,
            message: row.message,
            inputs: row.inputs,
            status: row.status,
            response: row.response,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
} 