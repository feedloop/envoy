import { StateFlow } from "../core/StateFlow";
import { JobRepo, JobSchema, EscalationRepo, EscalationStatus, EscalationReply, JobStatus } from "./types";
import { Json } from "../types";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from 'uuid';
import { StateObject } from "../core/StateObject";
import { EscalationInput, SerializedState, StateContext } from "../core/types";

interface SchedulerOptions {
    concurrency?: number;
    maxRetries?: number;
}

export class SchedulerService {
    private _flows: Record<string, StateFlow> = {};
    private _workerId: string;
    private _concurrency: number;
    private _executionLoopTimer?: NodeJS.Timeout;
    private _reviewLoopTimer?: NodeJS.Timeout;
    private _cleanupTimer?: NodeJS.Timeout;
    private _pendingJobsTimer?: NodeJS.Timeout;
    private _maxRetries: number;
    private _escalationRepo?: EscalationRepo;

    constructor(
        private _jobRepo: JobRepo,
        private _redis: Redis,
        options: SchedulerOptions = {},
        escalationRepo?: EscalationRepo
    ) {
        this._workerId = uuidv4();
        this._concurrency = options.concurrency ?? 4;
        this._maxRetries = options.maxRetries ?? 3;
        this._escalationRepo = escalationRepo;
    }

    public flow(name: string): StateFlow {
        if (!this._flows[name]) {
            throw new Error(`State machine '${name}' not found`);
        }
        return this._flows[name];
    }

    public addFlow(name: string, flow: StateFlow): void {
        this._flows[name] = flow;
    }

    public async schedule(name: string, input: Json): Promise<Json> {
        let context = this.flow(name).newContext(input);
        let job = await this._jobRepo.createJob({
            flow: name,
            status: "pending",
            context: context.serialize(),
            retries: 0,
        });
        
        // Queue just this specific job, don't call runPendingJobs which would re-queue the same first 10 jobs
        await Promise.all([
            this._redis.set(`job:${job.id}`, JSON.stringify(job)),
            this._redis.rpush('job_queue', job.id),
        ]);
        
        return job.id;
    }

    public job(id: string): Promise<JobSchema> {
        return this._jobRepo.getJob(id);
    }

    /**
     * Polls for pending jobs, marks them as running, assigns workerId, and replicates to Redis.
     * @param limit Max number of jobs to process at once (default 10)
     */
    public async runPendingJobs(limit: number = 10): Promise<void> {
        const jobs = await this._jobRepo.getPendingJobs(limit);
        await Promise.all(jobs.map(async job => {
            // Don't change status to running here - let doProcess claim it atomically
            // Just queue the job if it's not already in Redis
            const jobStr = await this._redis.get(`job:${job.id}`);
            if (!jobStr) {
                await Promise.all([
                    this._redis.set(`job:${job.id}`, JSON.stringify(job)),
                    this._redis.rpush('job_queue', job.id),
                ]);
            }
        }));
    }

    public async doProcess(): Promise<void> {
        // pop from job queue
        const jobId = await this._redis.lpop('job_queue');
        if (!jobId) return;
        
        try {
            // get job and verify it's still processable
            const job = await this._jobRepo.getJob(jobId);
            
            // Race condition protection: only process if job is pending or running (but not done/failed)
            if (!['pending', 'running'].includes(job.status)) {
                // Job already completed, failed, or cancelled by another worker
                return;
            }
            
            // If job is pending, atomically claim it by setting status to 'running'
            let updatedJob = job;
            if (job.status === 'pending') {
                updatedJob = await this._jobRepo.updateJob(job.id, { 
                    status: 'running',
                    startedAt: new Date() 
                });
            }
            // If job is already running, continue processing (might be a retry or continuation)
            
            // update job in Redis
            await this._redis.set(`job:${updatedJob.id}`, JSON.stringify(updatedJob));
            
            // step the job
            let newCtx: StateObject;
            let sm = this.flow(job.flow);
            try {
                newCtx = await sm.step(StateObject.from(job.context));
            } catch (error) {
                newCtx = StateObject.from(job.context);
                newCtx.error((error as Error)?.message ?? 'Unknown error');
                await this.handleFailedJob(newCtx, updatedJob);
                return;
            }
            
            // Handle spawn requests
            await this.handleSpawnRequests(newCtx, updatedJob);
            // Handle escalation requests
            await this.handleEscalationRequests(newCtx, updatedJob);
            
            // check if blocking
            if (newCtx.isWaitingFor().length > 0) {
                await this.handleBlockingJob(newCtx, updatedJob);
            // check if done
            } else if (newCtx.done() === "finished") {
                await this.handleFinishedJob(newCtx, updatedJob);
            // check if error
            } else if (newCtx.done() === "error") {
                await this.handleFailedJob(newCtx, updatedJob);
            // check if cancelled
            } else if (newCtx.done() === "cancelled") {
                await this.handleCancelledJob(newCtx, updatedJob);
            } else {
                // job is still in progress - update context and put back in queue
                await this._jobRepo.updateJob(updatedJob.id, { status: 'pending', context: newCtx.serialize() });
                await this._redis.set(`job:${updatedJob.id}`, JSON.stringify({ ...updatedJob, status: 'pending', context: newCtx.serialize() }));
                await this._redis.rpush('job_queue', jobId);
            }
        } catch (error) {
            // Handle job not found or other errors gracefully
            console.warn(`Failed to process job ${jobId}:`, error);
            // Job might have been deleted or corrupted, skip it
            return;
        }
    }

    /**
     * Handle spawn requests in the job context by creating child jobs
     */
    private async handleSpawnRequests(ctx: StateObject, parentJob: JobSchema): Promise<void> {
        const waitingMap = ctx.getWaitingMap();
        
        // Get or initialize processed spawns list
        const processedSpawns = ctx.get<string[]>('processedSpawns') || [];
        let hasNewSpawns = false;
        
        for (const [waitId, waitingContext] of Object.entries(waitingMap)) {
            if (waitingContext.type === 'spawn' && waitingContext.status === 'pending' && !processedSpawns.includes(waitId)) {
                const spawnParams = waitingContext.params as { sm: string, input: any };
                
                // Create child job
                const childJob = await this._jobRepo.createJob({
                    flow: spawnParams.sm,
                    status: 'pending',
                    context: this.flow(spawnParams.sm).newContext(spawnParams.input).serialize(),
                    parent_id: parentJob.id,
                    retries: 0,
                });
                
                // Update waiting context with child job ID
                waitingContext.childJobId = childJob.id;
                
                // Queue this specific child job directly, don't call runPendingJobs which has a limit
                await Promise.all([
                    this._redis.set(`job:${childJob.id}`, JSON.stringify(childJob)),
                    this._redis.rpush('job_queue', childJob.id),
                ]);
                
                // Mark this spawn as processed
                processedSpawns.push(waitId);
                hasNewSpawns = true;
            }
        }
        
        // Update processed spawns list in context
        if (hasNewSpawns) {
            ctx.set('processedSpawns', processedSpawns);
        }
    }

    /**
     * Handle escalation requests in the job context by creating escalation records
     */
    private async handleEscalationRequests(ctx: StateObject, job: JobSchema): Promise<void> {
        if (!this._escalationRepo) return;
        const waitingMap = ctx.getWaitingMap();
        // Get or initialize processed escalations list
        const processedEscalations = ctx.get<string[]>("processedEscalations") || [];
        let hasNewEscalations = false;
        for (const [waitId, waitingContext] of Object.entries(waitingMap)) {
            if (
                waitingContext.type === "escalate" &&
                waitingContext.status === "pending" &&
                !processedEscalations.includes(waitId)
            ) {
                const params = waitingContext.params as { user: string; message: string; inputs: EscalationInput[] };
                // Create escalation record
                const escalation = await this._escalationRepo.createEscalation({
                    job_id: job.id,
                    wait_id: waitId,
                    user: params.user,
                    message: params.message,
                    inputs: params.inputs,
                });
                // Set escalation metadata in context for workflow access (single escalation per state)
                ctx.set(`$escalation`, {
                    id: escalation.id,
                    user: escalation.user,
                    message: escalation.message,
                    inputs: escalation.inputs,
                    status: escalation.status,
                });
                processedEscalations.push(waitId);
                hasNewEscalations = true;
            }
        }
        if (hasNewEscalations) {
            ctx.set("processedEscalations", processedEscalations);
        }
    }

    public async handlePendingJob(ctx: StateObject, job: JobSchema): Promise<void> {
        await Promise.all([
            this._jobRepo.updateJob(job.id, { status: 'pending', context: ctx.serialize() }),
            this._redis.del(`job:${job.id}`),
            this._redis.lrem('blocking_jobs', 0, job.id),
            this._redis.rpush('job_queue', job.id),
        ]);
    }

    public async handleBlockingJob(ctx: StateObject, job: JobSchema): Promise<void> {
        await Promise.all([
            this._jobRepo.updateJob(job.id, { status: 'blocking', context: ctx.serialize() }),
            this._redis.rpush('blocking_jobs', job.id),
            this._redis.set(`job:${job.id}`, JSON.stringify({ ...job, status: 'blocking', context: ctx.serialize() })),
        ]);
    }

    public async handleFinishedJob(ctx: StateObject, job: JobSchema, handleParent: boolean = true): Promise<void> {
        ctx.setDone('finished');
        // has parent?
        if (job.parent_id && handleParent) {
            // update waiting map
            const parentJob = await this._jobRepo.getJob(job.parent_id);
            const parentCtx = StateObject.from(parentJob.context as SerializedState);
            const waitingMap = parentCtx.getWaitingMap();
            let waitId = Object.keys(waitingMap)
                .find(id => waitingMap[id].type === 'spawn' && waitingMap[id].childJobId === job.id);
            if (waitId) {
                const spawnEntry = waitingMap[waitId];
                const spawnName = (spawnEntry.params as any)?.name || waitId;
                
                // Resolve in waiting map
                parentCtx.resolve(waitId, 'success', ctx.output());
                
                // Also populate spawn data for easy access
                parentCtx.set(`$spawn.${spawnName}.status`, 'success');
                parentCtx.set(`$spawn.${spawnName}.result`, ctx.output() || null);
                parentCtx.set(`$spawn.${spawnName}.error`, null);
            }
            await Promise.all([
                this._jobRepo.updateJob(parentJob.id, { context: parentCtx.serialize() }),
                this._redis.set(`job:${parentJob.id}`, JSON.stringify({ ...parentJob, context: parentCtx.serialize() })),
            ]);
        }
        // update job in Postgres
        await Promise.all([
            this._jobRepo.updateJob(job.id, { status: 'done', finishedAt: new Date(), context: ctx.serialize() }),
            this._redis.del(`job:${job.id}`),
        ]);
    }

    public async handleFailedJob(ctx: StateObject, job: JobSchema, handleParent: boolean = true, handleChildren: boolean = true): Promise<void> {
        // retry logic
        if (job.retries < this._maxRetries) {
            const updatedJob = await this._jobRepo.updateJob(job.id, { retries: job.retries + 1, status: 'pending' });
            // Remove from Redis so it gets re-queued properly
            await this._redis.del(`job:${job.id}`);
            await this.runPendingJobs();
        } else {
            ctx.setDone('error');
            
            if (job.parent_id && handleParent) {
                const parentJob = await this._jobRepo.getJob(job.parent_id);
                const parentCtx = StateObject.from(parentJob.context as SerializedState);
                const waitingMap = parentCtx.getWaitingMap();
                const waitId = Object.keys(waitingMap)
                    .find(id => waitingMap[id].type === 'spawn' && waitingMap[id].childJobId === job.id);
                if (waitId) {
                    const spawnEntry = waitingMap[waitId];
                    const spawnName = (spawnEntry.params as any)?.name || waitId;
                    
                    // Resolve in waiting map
                    parentCtx.resolve(waitId, 'error', ctx.error());
                    
                    // Also populate spawn data for easy access
                    parentCtx.set(`$spawn.${spawnName}.status`, 'error');
                    parentCtx.set(`$spawn.${spawnName}.result`, null);
                    parentCtx.set(`$spawn.${spawnName}.error`, ctx.error() || 'Unknown error');
                    
                    // Update parent context and let it continue normally (no automatic failure)
                    await Promise.all([
                        this._jobRepo.updateJob(parentJob.id, { context: parentCtx.serialize() }),
                        this._redis.set(`job:${parentJob.id}`, JSON.stringify({ ...parentJob, context: parentCtx.serialize() })),
                    ]);
                }
            }
            if (handleChildren) {
                const childJobs = await this._jobRepo.getChildren(job.id);
                await Promise.all(childJobs.map(async childJob => 
                    this.handleCancelledJob(StateObject.from(childJob.context), childJob, false, true)));
            }
            // fail logic
            await Promise.all([
                this._jobRepo.setJobStatus(job.id, 'failed', ctx.error() ?? 'Unknown error'),
                this._redis.del(`job:${job.id}`),
                this._redis.lrem('job_queue', 0, job.id),
            ]);
        }
    }

    public async handleCancelledJob(ctx: StateObject, job: JobSchema, handleParent: boolean = true, handleChildren: boolean = true): Promise<void> {
        ctx.setDone('cancelled');
        
        // Cancel child jobs when parent is cancelled
        if (handleChildren) {
            const childJobs = await this._jobRepo.getChildren(job.id);
            await Promise.all(childJobs.map(async childJob => 
                this.handleCancelledJob(StateObject.from(childJob.context), childJob, false, true)));
        }
        
        // Handle parent when child is cancelled (but don't cancel the parent automatically)
        if (job.parent_id && handleParent) {
            const parentJob = await this._jobRepo.getJob(job.parent_id);
            const parentCtx = StateObject.from(parentJob.context as SerializedState);
            const waitingMap = parentCtx.getWaitingMap();
            const waitId = Object.keys(waitingMap)
                .find(id => waitingMap[id].type === 'spawn' && waitingMap[id].childJobId === job.id);
            if (waitId) {
                const spawnEntry = waitingMap[waitId];
                const spawnName = (spawnEntry.params as any)?.name || waitId;
                
                // Resolve in waiting map with cancelled status
                parentCtx.resolve(waitId, 'error', 'cancelled');
                
                // Also populate spawn data for easy access
                parentCtx.set(`$spawn.${spawnName}.status`, 'cancelled');
                parentCtx.set(`$spawn.${spawnName}.result`, null);
                parentCtx.set(`$spawn.${spawnName}.error`, 'cancelled');
                
                // Update parent context and let it continue normally (no automatic cancellation)
                await Promise.all([
                    this._jobRepo.updateJob(parentJob.id, { context: parentCtx.serialize() }),
                    this._redis.set(`job:${parentJob.id}`, JSON.stringify({ ...parentJob, context: parentCtx.serialize() })),
                ]);
            }
        }
        
        // Update job status to cancelled
        await Promise.all([
            this._jobRepo.updateJob(job.id, { status: 'cancelled', context: ctx.serialize() }),
            this._redis.del(`job:${job.id}`),
            this._redis.lrem('job_queue', 0, job.id),
            this._redis.lrem('blocking_jobs', 0, job.id), // Remove from blocking jobs too
        ]);
    }

    /**
     * Get job from Redis if present, otherwise from DB.
     */
    public async getJob(jobId: string): Promise<JobSchema> {
        const jobStr = await this._redis.get(`job:${jobId}`);
        if (jobStr) {
            try {
                const jobData = JSON.parse(jobStr);
                // Compose a JobSchema from Redis data (may be partial)
                return {
                    id: jobId,
                    flow: jobData.flow,
                    status: jobData.status,
                    context: jobData.context,
                    createdAt: jobData.createdAt ?? null,
                    updatedAt: jobData.updatedAt ?? null,
                    startedAt: jobData.startedAt ?? null,
                    finishedAt: jobData.finishedAt ?? null,
                    error: jobData.error ?? null,
                    retries: jobData.retries ?? 0,
                };
            } catch {
                // fallback to DB
            }
        }
        const job = await this._jobRepo.getJob(jobId);
        return job;
    }

    /**
     * Get job status from Redis if present, otherwise from DB.
     */
    public async getJobStatus(jobId: string): Promise<string> {
        const jobStr = await this._redis.get(`job:${jobId}`);
        if (jobStr) {
            try {
                const jobData = JSON.parse(jobStr);
                return jobData.status;
            } catch {
                // fallback to DB
            }
        }
        const job = await this._jobRepo.getJob(jobId);
        return job.status;
    }

    public async reviewBlockingJobs(): Promise<void> {
        const blockingJobIds = await this._redis.lrange('blocking_jobs', 0, -1);
        for (const jobId of blockingJobIds) {
            const job = await this.getJob(jobId);
            const ctx = StateObject.from(job.context as SerializedState);
            if (ctx.isWaitingFor().length === 0) {
                await this.handlePendingJob(ctx, job);
            }
        }
    }


    /**
     * Starts the distributed execution loop for running jobs.
     * @param intervalMs Polling interval in milliseconds (default 1000)
     */
    public start(intervalMs: number = 0): void {
        // Clear any existing timers first to prevent duplicates
        this.stop();
        
        // use setTimeouts to avoid race conditions
        let executionLoop = async () => {
            await this.doProcess();
            this._executionLoopTimer = setTimeout(executionLoop, intervalMs);
        };
        let reviewLoop = async () => {
            await this.reviewBlockingJobs();
            this._reviewLoopTimer = setTimeout(reviewLoop, intervalMs);
        };
        let cleanupLoop = async () => {
            await this.cleanupOrphanedJobs();
            this._cleanupTimer = setTimeout(cleanupLoop, intervalMs * 10);
        };
        let pendingJobsLoop = async () => {
            await this.runPendingJobs();
            this._pendingJobsTimer = setTimeout(pendingJobsLoop, intervalMs * 2);
        };
        this._executionLoopTimer = setTimeout(executionLoop, 0);
        this._reviewLoopTimer = setTimeout(reviewLoop, intervalMs);
        this._cleanupTimer = setTimeout(cleanupLoop, intervalMs * 10);
        this._pendingJobsTimer = setTimeout(pendingJobsLoop, intervalMs * 2);
    }

    /**
     * Stops the distributed execution loop.
     */
    public stop(): void {
        if (this._executionLoopTimer) {
            clearTimeout(this._executionLoopTimer);
            this._executionLoopTimer = undefined;
        }
        if (this._reviewLoopTimer) {
            clearTimeout(this._reviewLoopTimer);
            this._reviewLoopTimer = undefined;
        }
        if (this._cleanupTimer) {
            clearTimeout(this._cleanupTimer);
            this._cleanupTimer = undefined;
        }
        if (this._pendingJobsTimer) {
            clearTimeout(this._pendingJobsTimer);
            this._pendingJobsTimer = undefined;
        }
    }

    /**
     * List all jobs currently in the blocking_jobs queue, with their waitFor info.
     */
    public async listBlockingJobs(): Promise<{ job: JobSchema, blocking: string[] }[]> {
        const blockingJobIds = await this._redis.lrange('blocking_jobs', 0, -1);
        const jobs: { job: JobSchema, blocking: string[] }[] = [];
        for (const jobId of blockingJobIds) {
            const job = await this.getJob(jobId);
            const ctx = StateObject.from(job.context as SerializedState);
            const blocking = ctx.isWaitingFor();
            if (blocking.length > 0) {
                jobs.push({ job, blocking });
            }
        }
        return jobs;
    }

    /**
     * Scans for jobs stuck in 'pending' or 'running' for too long and marks them as failed.
     * @param maxAgeMs Maximum allowed age in milliseconds (default: 1 hour)
     */
    public async cleanupOrphanedJobs(maxAgeMs: number = 60 * 60 * 1000): Promise<void> {
        const jobs = await this._jobRepo.getStuckJobs(['pending', 'running'], maxAgeMs);
        await Promise.all(jobs.map(async job => {
            await this.handleFailedJob(StateObject.from(job.context), job, false, false);
        }));
    }

    /**
     * Approve or reject an escalation and resolve it in the job context.
     */
    public async replyToEscalation(escalationId: string, values: EscalationReply, status: 'approved' | 'rejected'): Promise<void> {
        if (!this._escalationRepo) throw new Error('No escalation repo configured');
        // 1. Update escalation status and response
        const escalation = await this._escalationRepo.updateEscalation(escalationId, {
            status,
            response: values,
        });
        // 2. Get the job and context
        const job = await this._jobRepo.getJob(escalation.job_id);
        const ctx = StateObject.from(job.context as SerializedState);
        // 3. Resolve the escalation in the waiting map using wait_id
        ctx.resolve(escalation.wait_id, status === 'approved' ? 'success' : 'error', values);
        // 4. Also populate escalation response data in ephemeral storage for easy access
        for (const [key, value] of Object.entries(values)) {
            ctx.set(`$escalation.${key}`, value);
        }
        // 5. Save updated context and update job status accordingly
        const stillBlocking = ctx.isWaitingFor().length > 0;
        let newStatus: JobStatus;
        if (stillBlocking) {
            newStatus = 'blocking';
        } else {
            newStatus = 'pending';
        }
        // Update in Postgres
        await this._jobRepo.updateJob(job.id, { context: ctx.serialize(), status: newStatus });
        // Update in Redis
        const jobStr = await this._redis.get(`job:${job.id}`);
        let jobData = jobStr ? JSON.parse(jobStr) : { ...job };
        jobData.context = ctx.serialize();
        jobData.status = newStatus;
        await this._redis.set(`job:${job.id}`, JSON.stringify(jobData));
        if (stillBlocking) {
            // Ensure in blocking_jobs queue
            const inQueue = (await this._redis.lrange('blocking_jobs', 0, -1)).includes(job.id);
            if (!inQueue) await this._redis.rpush('blocking_jobs', job.id);
        } else {
            // Remove from blocking_jobs queue and add to main job queue
            await this._redis.lrem('blocking_jobs', 0, job.id);
            await this._redis.rpush('job_queue', job.id);
        }
    }

    public async cancel(jobId: string): Promise<void> {
        const job = await this._jobRepo.getJob(jobId);
        const ctx = StateObject.from(job.context as SerializedState);
        await this.handleCancelledJob(ctx, job, true, true);
    }
}