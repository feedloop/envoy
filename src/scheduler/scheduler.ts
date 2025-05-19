import { StateMachine } from "../core/StateMachine";
import { JobRepo, JobSchema } from "./types";
import { Json } from "../types";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from 'uuid';
import { StateObject } from "../core/StateObject";
import { SerializedState } from "../core/types";

interface SchedulerOptions {
    concurrency?: number;
}

export class Scheduler {
    private _stateMachines: Record<string, StateMachine> = {};
    private _workerId: string;
    private _concurrency: number;
    private _executionLoopTimer?: NodeJS.Timeout;
    private _executionLoopActive: boolean = false;

    constructor(private _jobRepo: JobRepo, private _redis: Redis, options: SchedulerOptions = {}) {
        this._workerId = uuidv4();
        this._concurrency = options.concurrency ?? 4;
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
        });
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
                await sm.step(ctx); // If this throws, catch below
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
     */
    public async failJob(jobId: string, error?: string): Promise<void> {
        await this._jobRepo.setJobStatus(jobId, 'failed', error);
        await this._redis.srem('running_jobs', jobId);
        await this._redis.del(`job:${jobId}`);
        await this._redis.lrem('job_queue', 0, jobId);
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
}