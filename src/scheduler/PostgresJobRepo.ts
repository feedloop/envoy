import { Pool } from "pg";
import { JobRepo, JobSchema, JobStatus } from "./types";

export class PostgresJobRepo implements JobRepo {
    private pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    public async createJob(job: Omit<JobSchema, "id" | "createdAt" | "updatedAt">): Promise<JobSchema> {
        const res = await this.pool.query(
            `INSERT INTO jobs (id, flow, status, context, created_at, updated_at, started_at, finished_at, error, parent_id, retries)
             VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW(), $4, $5, $6, $7, $8)
             RETURNING *`,
            [job.flow, job.status, JSON.stringify(job.context), job.startedAt ?? null, job.finishedAt ?? null, job.error ?? null, job.parent_id ?? null, (job as any).retries ?? 0]
        );
        return this.rowToJob(res.rows[0]);
    }

    public async getJob(id: string): Promise<JobSchema> {
        const res = await this.pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
        if (res.rows.length === 0) throw new Error(`Job ${id} not found`);
        return this.rowToJob(res.rows[0]);
    }

    public async updateJob(id: string, updates: Partial<JobSchema>): Promise<JobSchema> {
        // Build dynamic SET clause
        const fields = [];
        const values = [];
        let idx = 1;
        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${this.toSnakeCase(key)} = $${idx}`);
            values.push(key === "context" ? JSON.stringify(value) : value);
            idx++;
        }
        values.push(id);
        const setClause = fields.join(", ");
        const res = await this.pool.query(
            `UPDATE jobs SET ${setClause}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
            values
        );
        if (res.rows.length === 0) throw new Error(`Job ${id} not found`);
        return this.rowToJob(res.rows[0]);
    }

    public async getPendingJobs(limit: number = 10): Promise<JobSchema[]> {
        const res = await this.pool.query(
            `SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
            [limit]
        );
        return res.rows.map(this.rowToJob);
    }

    public async setJobStatus(id: string, status: JobStatus, error?: string): Promise<JobSchema> {
        let finishedAt = null;
        if (status === "done" || status === "failed" || status === "cancelled") {
            finishedAt = new Date();
        }
        const res = await this.pool.query(
            `UPDATE jobs SET status = $1, error = $2, finished_at = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
            [status, error ?? null, finishedAt, id]
        );
        if (res.rows.length === 0) throw new Error(`Job ${id} not found`);
        return this.rowToJob(res.rows[0]);
    }

    public async close(): Promise<void> {
        await this.pool.end();
    }

    public async getStuckJobs(statuses: string[], maxAgeMs: number): Promise<JobSchema[]> {
        const cutoff = new Date(Date.now() - maxAgeMs);
        const res = await this.pool.query(
            `SELECT * FROM jobs WHERE status = ANY($1) AND updated_at < $2`,
            [statuses, cutoff]
        );
        return res.rows.map(this.rowToJob);
    }

    private rowToJob(row: any): JobSchema {
        return {
            id: row.id,
            flow: row.flow,
            status: row.status,
            context: row.context,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            error: row.error,
            parent_id: row.parent_id ?? null,
            retries: row.retries ?? 0,
        };
    }

    private toSnakeCase(str: string): string {
        return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    }
} 