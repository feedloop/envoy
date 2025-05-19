import { SerializedState, StateContext } from "../core/types";

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "blocking";

export interface JobSchema {
    id: string;
    stateMachine: string;
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