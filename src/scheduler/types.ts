import { EscalationInput, SerializedState, StateContext } from "../core/types";
import { Json } from "../types";

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "blocking";

export interface JobSchema {
    id: string;
    flow: string;
    status: JobStatus;
    context: SerializedState;
    createdAt: Date;
    updatedAt: Date;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    error?: string | null;
    parent_id?: string | null;
    retries: number;
}

export interface JobRepo {
    createJob(job: Omit<JobSchema, "id" | "createdAt" | "updatedAt">): Promise<JobSchema>;
    getJob(id: string): Promise<JobSchema>;
    updateJob(id: string, updates: Partial<JobSchema>): Promise<JobSchema>;
    getPendingJobs(limit?: number): Promise<JobSchema[]>;
    setJobStatus(id: string, status: JobStatus, error?: string): Promise<JobSchema>;
    getStuckJobs(statuses: string[], maxAgeMs: number): Promise<JobSchema[]>;
}

export type EscalationStatus = 'pending' | 'approved' | 'rejected' | 'resolved';

export interface Escalation {
    id: string;
    job_id: string;
    wait_id: string;
    user: string;
    message: string;
    inputs: EscalationInput[];
    status: EscalationStatus;
    response?: EscalationReply;
    created_at: Date;
    updated_at: Date;
}

export interface EscalationRepo {
    createEscalation(escalation: Omit<Escalation, 'id' | 'created_at' | 'updated_at' | 'status'>): Promise<Escalation>;
    getEscalation(id: string): Promise<Escalation>;
    updateEscalation(id: string, updates: Partial<Escalation>): Promise<Escalation>;
    listPendingEscalations(): Promise<Escalation[]>;
}

export type EscalationReply = { [inputId: string]: Json  };

export type SchedulerConfig = {
    redis?: {
        host?: string;
        port?: number;
        password?: string;
    }
    postgres?: {
        host?: string;
        port?: number;
        password?: string;
        database?: string;
    }
    concurrency?: number;
    maxRetries?: number;
}