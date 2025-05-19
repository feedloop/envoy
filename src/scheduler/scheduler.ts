import { StateMachine } from "../core/StateMachine";
import { JobRepo, JobSchema, EscalationRepo, EscalationStatus, EscalationReply, JobStatus } from "./types";
import { Json } from "../types";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from 'uuid';
import { StateObject } from "../core/StateObject";
import { EscalationInput, SerializedState } from "../core/types";

interface SchedulerOptions {
    concurrency?: number;
    maxRetries?: number;
}

export class Scheduler {
    private _stateMachines: Record<string, StateMachine> = {};
    private _workerId: string;
    private _concurrency: number;
    private _executionLoopTimer?: NodeJS.Timeout;
    private _executionLoopActive: boolean = false;
    private _cleanupTimer?: NodeJS.Timeout;
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

    public stateMachine(name: string): StateMachine {
        if (!this._stateMachines[name]) {
            throw new Error(`State machine '${name}' not found`);
        }
        return this._stateMachines[name];
    }

    public addStateMachine(name: string, stateMachine: StateMachine): void {
        this._stateMachines[name] = stateMachine;
    }

    public async schedule(name: string, input: Json): Promise<Json> {
        let context = this.stateMachine(name).newContext(input);
        let job = await this._jobRepo.createJob({
            stateMachine: name,
            status: "pending",
            context: context.serialize(),
            retries: 0,
        });
        return job.id;
    }

    public job(id: string): Promise<JobSchema> {
        return this._jobRepo.getJob(id);
    }

    /**
     * Internal helper to handle moving a job to the blocking queue and updating status.
     */
    private async _handleBlockingJob(jobId: string, jobData: any, ctx: StateObject, queueNames: string[] = []) {
        jobData.status = 'blocking';
        jobData.context = ctx.serialize();
        await this._redis.set(`job:${jobId}`, JSON.stringify(jobData));
        // Remove from any provided queues
        for (const queue of queueNames) {
            await this._redis.lrem(queue, 0, jobId);
        }
        // Add to blocking_jobs queue if not already present
        const inBlocking = (await this._redis.lrange('blocking_jobs', 0, -1)).includes(jobId);
        if (!inBlocking) await this._redis.rpush('blocking_jobs', jobId);
    }

    /**
     * Polls for pending jobs, marks them as running, assigns workerId, and replicates to Redis.
     * @param limit Max number of jobs to process at once (default 10)
     */
    public async runPendingJobs(limit: number = 10): Promise<void> {
        // 1. Fetch pending jobs
        const pendingJobs = await this._jobRepo.getPendingJobs(limit);
        for (const job of pendingJobs) {
            // 2. Assign workerId in context
            const context = Object.assign({}, job.context || {}, { workerId: this._workerId });
            // 3. Mark as running in Postgres
            const runningJob = await this._jobRepo.updateJob(job.id, {
                status: 'running',
                context,
                startedAt: new Date(),
            });
            // 4. Replicate to Redis
            await this._redis.sadd('running_jobs', job.id);
            await this._redis.set(`job:${job.id}`, JSON.stringify({ ...runningJob, workerId: this._workerId }));
            // 5. Add to global job queue
            await this._redis.rpush('job_queue', job.id);

            // 6. Try to step the state machine and handle errors
            try {
                const sm = this.stateMachine(runningJob.stateMachine);
                let ctx = StateObject.from(runningJob.context as SerializedState);
                ctx = await sm.step(ctx) as StateObject; // If this throws, catch below
                // Handle spawn jobs
                const waitingMap = ctx.getWaitingMap();
                for (const waitId of ctx.isWaitingFor()) {
                    const wait = waitingMap[waitId];
                    if (wait.type === 'spawn' && wait.status === 'pending' && !wait.childJobId && wait.params && typeof wait.params.sm === 'string') {
                        // Create child job
                        const childJob = await this._jobRepo.createJob({
                            stateMachine: wait.params.sm,
                            status: 'pending',
                            context: this.stateMachine(wait.params.sm).newContext(wait.params.input).serialize(),
                            parent_id: job.id,
                            retries: 0,
                        });
                        // Store mapping for easier resolution
                        wait.childJobId = childJob.id;
                    }
                }
                // --- NEW: Handle escalate waits ---
                if (this._escalationRepo) {
                    for (const waitId of ctx.isWaitingFor()) {
                        const wait = waitingMap[waitId];
                        if (wait.type === 'escalate' && wait.status === 'pending' && wait.params) {
                            // Check if escalation already exists for this job+waitId
                            const existing = await this._escalationRepo.listPendingEscalations();
                            const alreadyExists = existing.some(e => e.job_id === job.id && e.wait_id === waitId);
                            if (!alreadyExists) {
                                await this._escalationRepo.createEscalation({
                                    job_id: job.id,
                                    wait_id: waitId,
                                    user: wait.params.user as string,
                                    message: wait.params.message as string,
                                    inputs: wait.params.inputs as EscalationInput[]
                                });
                            }
                        }
                    }
                }
                // --- END NEW ---
                // Save updated context if any child jobs were created
                await this._jobRepo.updateJob(job.id, { context: ctx.serialize() });
                // Handle blocking jobs
                if (ctx.isWaitingFor && ctx.isWaitingFor().length > 0) {
                    const jobStr = await this._redis.get(`job:${job.id}`);
                    let jobData = jobStr ? JSON.parse(jobStr) : { ...runningJob };
                    await this._handleBlockingJob(job.id, jobData, ctx, ['job_queue']);
                }
            } catch (err) {
                await this.failJob(job.id, err instanceof Error ? err.message : String(err));
            }
        }
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
                    stateMachine: jobData.stateMachine,
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
        return this._jobRepo.getJob(jobId);
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

    /**
     * Mark a job as completed, update Postgres and clean up Redis.
     */
    public async completeJob(jobId: string): Promise<void> {
        // Child job completion logic for spawn
        const job = await this._jobRepo.getJob(jobId);
        if (job.parent_id) {
            // 1. Load parent job and context
            const parentJob = await this._jobRepo.getJob(job.parent_id);
            const parentCtx = StateObject.from(parentJob.context as SerializedState);
            const waitingMap = parentCtx.getWaitingMap();
            // 2. Find the waitFor entry for this child
            for (const waitId in waitingMap) {
                const wait = waitingMap[waitId];
                if (wait.type === 'spawn' && wait.childJobId === jobId) {
                    // 3. Write result to output
                    let childOutput: Json | null = null;
                    try {
                        childOutput = StateObject.from(job.context as SerializedState).output() ?? null;
                    } catch { /* fallback to null */ }
                    parentCtx.output(`jobs.${jobId}`, childOutput);
                    // 4. Mark as resolved
                    parentCtx.resolve(waitId, "success", childOutput);
                }
            }
            // 5. Save updated parent context
            await this._jobRepo.updateJob(parentJob.id, { context: parentCtx.serialize() });
            // 6. If all waitFor resolved, requeue parent
            if (parentCtx.isWaitingFor().length === 0) {
                await this._jobRepo.updateJob(parentJob.id, { status: 'pending', context: parentCtx.serialize() });
                await this._redis.rpush('job_queue', parentJob.id);
                // Immediately process the parent job
                await this.runPendingJobs();
            }
        }
        // Existing completion logic
        const status = await this.getJobStatus(jobId);
        if (!['failed', 'cancelled', 'done'].includes(status)) {
            await this._jobRepo.setJobStatus(jobId, 'done');
        }
        await this._redis.srem('running_jobs', jobId);
        await this._redis.del(`job:${jobId}`);
        await this._redis.lrem('job_queue', 0, jobId);
    }

    /**
     * Mark a job as failed, update Postgres and clean up Redis.
     * If retries < maxRetries, increment retries and requeue as pending.
     */
    public async failJob(jobId: string, error?: string): Promise<void> {
        const job = await this._jobRepo.getJob(jobId);
        if (job.parent_id) {
            // 1. Load parent job and context
            const parentJob = await this._jobRepo.getJob(job.parent_id);
            const parentCtx = StateObject.from(parentJob.context as SerializedState);
            const waitingMap = parentCtx.getWaitingMap();
            // 2. Find the waitFor entry for this child
            for (const waitId in waitingMap) {
                const wait = waitingMap[waitId];
                if (wait.type === 'spawn' && wait.childJobId === jobId) {
                    // 3. Mark as error
                    parentCtx.resolve(waitId, "error", error ?? "Child job failed");
                }
            }
            // 4. Save updated parent context
            await this._jobRepo.updateJob(parentJob.id, { context: parentCtx.serialize() });
            // 5. If all waitFor resolved, requeue parent
            if (parentCtx.isWaitingFor().length === 0) {
                await this._jobRepo.updateJob(parentJob.id, { status: 'pending', context: parentCtx.serialize() });
                await this._redis.rpush('job_queue', parentJob.id);
                // Immediately process the parent job
                await this.runPendingJobs();
            }
        }
        // Retry logic
        if (job.retries < this._maxRetries) {
            await this._jobRepo.updateJob(jobId, { retries: job.retries + 1, status: 'pending' });
            await this._redis.rpush('job_queue', jobId);
        } else {
            // Existing fail logic
            await this._jobRepo.setJobStatus(jobId, 'failed', error);
            await this._redis.srem('running_jobs', jobId);
            await this._redis.del(`job:${jobId}`);
            await this._redis.lrem('job_queue', 0, jobId);
        }
    }

    /**
     * Mark a job as cancelled, update Postgres and clean up Redis.
     */
    public async cancelJob(jobId: string): Promise<void> {
        // Set status to 'cancelled' in Redis job object if it exists
        const jobStr = await this._redis.get(`job:${jobId}`);
        if (jobStr) {
            try {
                const jobData = JSON.parse(jobStr);
                jobData.status = 'cancelled';
                await this._redis.set(`job:${jobId}`, JSON.stringify(jobData));
            } catch {}
        }
        await this._jobRepo.setJobStatus(jobId, 'cancelled');
        await this._redis.srem('running_jobs', jobId);
        await this._redis.del(`job:${jobId}`);
        await this._redis.lrem('job_queue', 0, jobId);
    }

    /**
     * Starts the distributed execution loop for running jobs.
     * @param intervalMs Polling interval in milliseconds (default 1000)
     * @param lockTtlMs Lock TTL in milliseconds (default 10000)
     */
    public startExecutionLoop(intervalMs: number = 1000, lockTtlMs: number = 10000): void {
        const workerQueue = `worker:${this._workerId}:queue`;
        let activeJobs = 0;
        this._executionLoopActive = true;
        const processJob = async (jobId: string) => {
            const lockKey = `job:${jobId}:lock`;
            const lockVal = this._workerId;
            // Try to acquire lock
            const acquired = await this._redis.set(lockKey, lockVal, 'PX', lockTtlMs, 'NX');
            if (!acquired) {
                // If lock not acquired, requeue and try next
                await this._redis.rpush(workerQueue, jobId);
                return;
            }
            try {
                // Load context from Redis
                const jobStr = await this._redis.get(`job:${jobId}`);
                if (!jobStr) return;
                let jobData;
                try { jobData = JSON.parse(jobStr); } catch { return; }
                // Check for cancellation at top level
                if (jobData.status === 'cancelled') {
                    await this.cancelJob(jobId);
                    return;
                }
                let ctx = StateObject.from(jobData.context);
                // Step the state machine
                const sm = this.stateMachine(jobData.stateMachine);
                const newCtx = await sm.step(ctx);
                // Update context in Redis
                jobData.context = newCtx.serialize();
                // If job is done, clean up
                if (newCtx.done()) {
                    await this.completeJob(jobId);
                } else if (newCtx.error) {
                    await this.failJob(jobId, newCtx.error);
                } else if (newCtx.isWaitingFor && newCtx.isWaitingFor().length > 0) {
                    await this._handleBlockingJob(jobId, jobData, newCtx as StateObject, [workerQueue, 'job_queue']);
                } else {
                    await this._redis.set(`job:${jobId}`, JSON.stringify(jobData));
                    // Requeue job for next step
                    await this._redis.rpush(workerQueue, jobId);
                }
                // Async sync to Postgres (non-blocking)
                setTimeout(() => {
                    this._jobRepo.updateJob(jobId, {
                        context: jobData.context,
                        status: newCtx.done() ? 'done' : jobData.status,
                        error: newCtx.error || undefined,
                    }).catch(() => {});
                }, 0);
            } finally {
                await this._redis.del(lockKey);
                activeJobs--;
            }
        };
        const loop = async () => {
            if (!this._executionLoopActive) return;
            try {
                // Fill worker queue up to concurrency
                while (activeJobs < this._concurrency) {
                    // Atomically move job from global queue to worker queue
                    const jobId = await this._redis.rpoplpush('job_queue', workerQueue);
                    if (!jobId) break;
                    activeJobs++;
                    processJob(jobId).then(() => setTimeout(loop, 0));
                }
            } catch (err) {
                // Optionally log error
            } finally {
                this._executionLoopTimer = setTimeout(loop, intervalMs);
            }
        };
        loop();
    }

    /**
     * Stops the distributed execution loop.
     */
    public stopExecutionLoop(): void {
        this._executionLoopActive = false;
        if (this._executionLoopTimer) {
            clearTimeout(this._executionLoopTimer);
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
     * Resolve a specific waitFor on a blocking job. If no more waits, move back to main queue and set status to 'pending'.
     * Updates Redis immediately, Postgres asynchronously.
     */
    public async resolveBlockingJob(jobId: string, waitForId: string, output?: Json): Promise<void> {
        const job = await this.getJob(jobId);
        const ctx = StateObject.from(job.context as SerializedState);
        ctx.resolve(waitForId, 'success', output);
        const stillBlocking = ctx.isWaitingFor().length > 0;
        // Update context and status in Redis
        const jobStr = await this._redis.get(`job:${jobId}`);
        let jobData = jobStr ? JSON.parse(jobStr) : { ...job };
        jobData.context = ctx.serialize();
        if (stillBlocking) {
            jobData.status = 'blocking';
            await this._redis.set(`job:${jobId}`, JSON.stringify(jobData));
            // Ensure in blocking_jobs queue
            const inQueue = (await this._redis.lrange('blocking_jobs', 0, -1)).includes(jobId);
            if (!inQueue) await this._redis.rpush('blocking_jobs', jobId);
        } else {
            jobData.status = 'pending';
            await this._redis.set(`job:${jobId}`, JSON.stringify(jobData));
            // Remove from blocking_jobs queue
            await this._redis.lrem('blocking_jobs', 0, jobId);
            // Add back to main job queue
            await this._redis.rpush('job_queue', jobId);
        }
        // Async update to Postgres
        setTimeout(() => {
            this._jobRepo.updateJob(jobId, {
                context: jobData.context,
                status: jobData.status,
            }).catch(() => {});
        }, 0);
    }

    /**
     * Scans for jobs stuck in 'pending' or 'running' for too long and marks them as failed.
     * @param maxAgeMs Maximum allowed age in milliseconds (default: 1 hour)
     */
    public async cleanupOrphanedJobs(maxAgeMs: number = 60 * 60 * 1000): Promise<void> {
        const jobs = await this._jobRepo.getStuckJobs(['pending', 'running'], maxAgeMs);
        for (const job of jobs) {
            await this.failJob(job.id, 'Orphaned job: exceeded max allowed age');
            console.warn(`Orphaned job ${job.id} marked as failed.`);
        }
    }

    /**
     * Starts the execution loop and schedules periodic orphaned job cleanup.
     * @param intervalMs Polling interval for execution loop (default 1000)
     * @param cleanupIntervalMs How often to run orphaned job cleanup (default 1 hour)
     * @param orphanMaxAgeMs Max age for a job to be considered orphaned (default 1 hour)
     */
    public start(intervalMs: number = 1000, cleanupIntervalMs: number = 60 * 60 * 1000, orphanMaxAgeMs: number = 60 * 60 * 1000): void {
        this.startExecutionLoop(intervalMs);
        this._cleanupTimer = setInterval(() => {
            this.cleanupOrphanedJobs(orphanMaxAgeMs).catch(console.error);
        }, cleanupIntervalMs);
    }

    /**
     * Stops the execution loop and orphaned job cleanup.
     */
    public stop(): void {
        this.stopExecutionLoop();
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = undefined;
        }
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
        // 4. Save updated context and update job status accordingly
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
}