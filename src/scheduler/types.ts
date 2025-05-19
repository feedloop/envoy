import { SerializedState, StateContext } from "../core/types";
import { Json } from "../types";

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "blocking";

export interface JobSchema {
    id: string;
    stateMachine: string;
    status: JobStatus;
    context: Json; // serialized context (JSON)
    createdAt: Date;
    updatedAt: Date;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    error?: string | null;
}

export interface JobRepo {
    createJob(job: Omit<JobSchema, "id" | "createdAt" | "updatedAt">): Promise<JobSchema>;
    getJob(id: string): Promise<JobSchema>;
    updateJob(id: string, updates: Partial<JobSchema>): Promise<JobSchema>;
    getPendingJobs(limit?: number): Promise<JobSchema[]>;
    setJobStatus(id: string, status: JobStatus, error?: string): Promise<JobSchema>;
}