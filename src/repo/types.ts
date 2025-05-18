export interface JobRepo {
    getJob(jobId: string): Promise<Job>;
    createJob(job: Job): Promise<Job>;
    updateJob(job: Job): Promise<Job>;
    deleteJob(jobId: string): Promise<void>;
}

export interface Job {
    id: string;
    state: string;
}