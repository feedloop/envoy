import { SchedulerService } from '../../src/scheduler/SchedulerService';
import { StateFlow } from '../../src/core/StateFlow';
import { StateObject } from '../../src/core/StateObject';
import { JobRepo, JobSchema, JobStatus } from '../../src/scheduler/types';
import { Json } from '../../src/types';

// Simple in-memory JobRepo mock
class InMemoryJobRepo implements JobRepo {
    jobs: Record<string, JobSchema> = {};
    children: Record<string, string[]> = {};
    async createJob(job: Omit<JobSchema, 'id' | 'createdAt' | 'updatedAt'>): Promise<JobSchema> {
        const id = 'job-' + Object.keys(this.jobs).length;
        const now = new Date();
        const jobObj: JobSchema = {
            ...job,
            id,
            createdAt: now,
            updatedAt: now,
            retries: job.retries ?? 0,
        };
        this.jobs[id] = jobObj;
        if (jobObj.parent_id) {
            this.children[jobObj.parent_id] = this.children[jobObj.parent_id] || [];
            this.children[jobObj.parent_id].push(id);
        }
        return jobObj;
    }
    async getJob(id: string): Promise<JobSchema> {
        if (!this.jobs[id]) throw new Error('Job not found');
        return this.jobs[id];
    }
    async updateJob(id: string, updates: Partial<JobSchema>): Promise<JobSchema> {
        if (!this.jobs[id]) throw new Error('Job not found');
        this.jobs[id] = { ...this.jobs[id], ...updates, updatedAt: new Date() };
        return this.jobs[id];
    }
    async getPendingJobs(limit = 10): Promise<JobSchema[]> {
        return Object.values(this.jobs).filter(j => j.status === 'pending').slice(0, limit);
    }
    async setJobStatus(id: string, status: JobStatus, error?: string): Promise<JobSchema> {
        if (!this.jobs[id]) throw new Error('Job not found');
        this.jobs[id].status = status;
        this.jobs[id].error = error;
        this.jobs[id].updatedAt = new Date();
        if (status === 'done' || status === 'failed' || status === 'cancelled') {
            this.jobs[id].finishedAt = new Date();
        }
        return this.jobs[id];
    }
    async getStuckJobs(statuses: string[], maxAgeMs: number): Promise<JobSchema[]> {
        const cutoffTime = new Date(Date.now() - maxAgeMs);
        return Object.values(this.jobs).filter(job => {
            return statuses.includes(job.status) && 
                   job.startedAt && 
                   job.startedAt < cutoffTime;
        });
    }
    async getChildren(id: string): Promise<JobSchema[]> {
        return (this.children[id] || []).map(cid => this.jobs[cid]);
    }
    async getAllJobs(): Promise<JobSchema[]> {
        return Object.values(this.jobs);
    }
}

// Simple in-memory Redis mock
class InMemoryRedis {
    store: Record<string, any> = {};
    lists: Record<string, string[]> = {};
    async get(key: string) { return this.store[key] || null; }
    async set(key: string, value: any) { this.store[key] = value; }
    async del(key: string) { delete this.store[key]; }
    async rpush(key: string, value: string) {
        this.lists[key] = this.lists[key] || [];
        this.lists[key].push(value);
    }
    async lpop(key: string) {
        this.lists[key] = this.lists[key] || [];
        return this.lists[key].shift() || null;
    }
    async lrem(key: string, _count: number, value: string) {
        this.lists[key] = (this.lists[key] || []).filter(v => v !== value);
    }
    async lrange(key: string, start: number, end: number) {
        const list = this.lists[key] || [];
        if (end === -1) return list.slice(start);
        return list.slice(start, end + 1);
    }
    async llen(key: string): Promise<number> {
        return this.lists[key]?.length || 0;
    }
}

describe('SchedulerService', () => {
    it('should schedule and complete a simple job', async () => {
        // Minimal state machine: A -> B (done)
        const flow = new StateFlow([
            { name: 'A', onState: async ctx => ctx, router: { next: 'B' } },
            { name: 'B', onState: async ctx => { ctx.set('result', 42); return ctx; }, router: { next: null } },
        ], { startState: 'A' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any);
        scheduler.addFlow('test', flow);

        // Schedule a job
        const jobId = await scheduler.schedule('test', { foo: 'bar' });
        
        // Ensure job is queued to Redis
        await scheduler.runPendingJobs();
        
        // Process until job is complete
        let attempts = 0;
        let job = await jobRepo.getJob(jobId as string);
        while (!['done', 'failed'].includes(job.status) && attempts < 10) { // Safety limit
            await scheduler.doProcess();
            job = await jobRepo.getJob(jobId as string);
            attempts++;
        }

        expect(job.status).toBe('done');
        expect(StateObject.from(job.context).get('result')).toBe(42);
    });

    it('should retry a failed job and eventually succeed', async () => {
        let attemptCount = 0;
        const flow = new StateFlow([
            { 
                name: 'A', 
                onState: async ctx => {
                    attemptCount++;
                    if (attemptCount === 1) {
                        throw new Error('Simulated failure on first attempt');
                    }
                    ctx.set('success', true);
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'A' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, { maxRetries: 2 });
        scheduler.addFlow('retry-test', flow);

        const jobId = await scheduler.schedule('retry-test', { test: 'retry' });
        
        // Process until job is complete
        let attempts = 0;
        let job = await jobRepo.getJob(jobId as string);
        while (!['done', 'failed'].includes(job.status) && attempts < 20) {
            await scheduler.doProcess();
            job = await jobRepo.getJob(jobId as string);
            
            // If job is pending, ensure it gets picked up
            if (job.status === 'pending') {
                await scheduler.runPendingJobs();
                job = await jobRepo.getJob(jobId as string);
            }
            
            attempts++;
        }

        expect(job.status).toBe('done');
        expect(job.retries).toBe(1); // Should have retried once
        expect(StateObject.from(job.context).get('success')).toBe(true);
        expect(attemptCount).toBe(2); // Failed once, succeeded on retry
    });

    it('should permanently fail a job that exceeds max retries', async () => {
        const flow = new StateFlow([
            { 
                name: 'A', 
                onState: async ctx => {
                    throw new Error('Always fails');
                }, 
                router: { next: null } 
            },
        ], { startState: 'A' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, { maxRetries: 2 });
        scheduler.addFlow('fail-test', flow);

        const jobId = await scheduler.schedule('fail-test', { test: 'fail' });
        
        // Process until job is complete
        let attempts = 0;
        let job = await jobRepo.getJob(jobId as string);
        while (!['done', 'failed'].includes(job.status) && attempts < 20) {
            await scheduler.doProcess();
            job = await jobRepo.getJob(jobId as string);
            attempts++;
        }

        expect(job.status).toBe('failed');
        expect(job.retries).toBe(2); // Should have retried maxRetries times
        expect(job.error).toBe('Always fails');
    });

    it('should handle jobs that error in state execution', async () => {
        const flow = new StateFlow([
            { name: 'A', onState: async ctx => ctx, router: { next: 'B' } },
            { 
                name: 'B', 
                onState: async ctx => {
                    throw new Error('State B failed');
                }, 
                router: { next: null } 
            },
        ], { startState: 'A' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, { maxRetries: 1 });
        scheduler.addFlow('error-test', flow);

        const jobId = await scheduler.schedule('error-test', { test: 'error' });
        
        // Process until job is complete
        let attempts = 0;
        let job = await jobRepo.getJob(jobId as string);
        while (!['done', 'failed'].includes(job.status) && attempts < 20) {
            await scheduler.doProcess();
            job = await jobRepo.getJob(jobId as string);
            attempts++;
        }

        expect(job.status).toBe('failed');
        expect(job.error).toBe('State B failed');
        expect(job.retries).toBe(1);
    });

    it('should handle parent-child job spawning', async () => {
        // Child flow: simple computation
        const childFlow = new StateFlow([
            { 
                name: 'compute', 
                onState: async ctx => {
                    const input = ctx.input<{value: number}>();
                    ctx.output({ result: input.value * 2 });
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'compute' });

        // Parent flow: spawns child in onEnter and uses result in onState
        const parentFlow = new StateFlow([
            { 
                name: 'spawn-and-use-result', 
                onEnter: async ctx => {
                    // Spawn in onEnter so result is available in onState
                    ctx.spawn('computation', 'child-flow', { value: 21 });
                    return ctx;
                },
                onState: async ctx => {
                    const status = ctx.get<string>('$spawn.computation.status');
                    
                    if (status === 'success') {
                        const childOutput = ctx.get<{result: number}>('$spawn.computation.result');
                        ctx.output({ final: childOutput.result + 10 });
                        return ctx;
                    } else if (status === 'error') {
                        const error = ctx.get<string>('$spawn.computation.error');
                        throw new Error(`Child failed: ${error}`);
                    }
                    // If status is undefined, keep waiting (don't output anything)
                    return ctx;
                },
                router: { next: null } 
            },
        ], { startState: 'spawn-and-use-result' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any);
        scheduler.addFlow('parent-flow', parentFlow);
        scheduler.addFlow('child-flow', childFlow);

        const parentJobId = await scheduler.schedule('parent-flow', { test: 'spawn' });
        
        // Process jobs until completion
        for (let attempt = 1; attempt <= 5; attempt++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        const parentJob = await jobRepo.getJob(parentJobId as string);
        expect(parentJob.status).toBe('done');
        
        const parentContext = StateObject.from(parentJob.context);
        expect(parentContext.output()).toEqual({ final: 52 }); // (21 * 2) + 10 = 52
    });

    it('should handle parent-child job spawning with child failure', async () => {
        // Child flow that always fails
        const failingChildFlow = new StateFlow([
            { 
                name: 'fail', 
                onState: async ctx => {
                    throw new Error('Child intentionally failed');
                }, 
                router: { next: null } 
            },
        ], { startState: 'fail' });

        // Parent flow: spawns child and handles failure
        const parentFlow = new StateFlow([
            { 
                name: 'spawn-and-handle-result', 
                onEnter: async ctx => {
                    // Spawn in onEnter so result is available in onState
                    ctx.spawn('computation', 'failing-child-flow', { value: 21 });
                    return ctx;
                },
                onState: async ctx => {
                    const status = ctx.get<string>('$spawn.computation.status');
                    if (status === 'error') {
                        const error = ctx.get<string>('$spawn.computation.error');
                        ctx.output({ error: `Child failed: ${error}` });
                    } else {
                        ctx.output({ error: 'Unexpected status' });
                    }
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'spawn-and-handle-result' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, { maxRetries: 1 });
        scheduler.addFlow('parent-flow', parentFlow);
        scheduler.addFlow('failing-child-flow', failingChildFlow);

        const parentJobId = await scheduler.schedule('parent-flow', { test: 'spawn-error' });
        
        // Process jobs until completion
        for (let attempt = 1; attempt <= 10; attempt++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        const parentJob = await jobRepo.getJob(parentJobId as string);
        expect(parentJob.status).toBe('done');
        
        const parentContext = StateObject.from(parentJob.context);
        const output = parentContext.output() as { error: string };
        expect(output.error).toContain('Child failed');
        expect(output.error).toContain('Child intentionally failed');
    });

    it('should fail parent when child fails and parent does not handle error', async () => {
        // Child flow that always fails
        const failingChildFlow = new StateFlow([
            { 
                name: 'fail', 
                onState: async ctx => {
                    throw new Error('Child intentionally failed');
                }, 
                router: { next: null } 
            },
        ], { startState: 'fail' });

        // Parent flow: spawns child but doesn't handle failure (bad code)
        const parentFlow = new StateFlow([
            { 
                name: 'spawn-and-use-result-blindly', 
                onEnter: async ctx => {
                    // Spawn in onEnter so result is available in onState
                    ctx.spawn('computation', 'failing-child-flow', { value: 21 });
                    return ctx;
                },
                onState: async ctx => {
                    // BAD: Assumes success without checking status
                    const result = ctx.get<{result: number}>('$spawn.computation.result');
                    ctx.output({ final: result.result + 10 }); // Will throw!
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'spawn-and-use-result-blindly' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, { maxRetries: 1 });
        scheduler.addFlow('bad-parent-flow', parentFlow);
        scheduler.addFlow('failing-child-flow', failingChildFlow);

        const parentJobId = await scheduler.schedule('bad-parent-flow', { test: 'unhandled-spawn-error' });
        
        // Process jobs until completion
        for (let attempt = 1; attempt <= 15; attempt++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        const parentJob = await jobRepo.getJob(parentJobId as string);
        expect(parentJob.status).toBe('failed'); // Parent should fail!
        expect(parentJob.error).toContain('Cannot read properties of null'); // Should contain the null access error
    });

    it('should cancel children when parent is cancelled', async () => {
        // Long-running child flow that never completes
        const longChildFlow = new StateFlow([
            { 
                name: 'infinite-work', 
                onState: async ctx => {
                    // This state never calls ctx.output() so it never completes
                    ctx.set('working', true);
                    return ctx; // Returns without calling ctx.output() - stays in progress
                }, 
                router: { next: 'infinite-work' } // Loop back to itself, never completes
            },
        ], { startState: 'infinite-work' });

        // Parent flow that spawns and waits for child
        const parentFlow = new StateFlow([
            { 
                name: 'spawn-and-wait', 
                onEnter: async ctx => {
                    // Spawn in onEnter so result is available in onState
                    ctx.spawn('worker', 'long-child-flow', { work: 'data' });
                    return ctx;
                },
                onState: async ctx => {
                    const status = ctx.get<string>('$spawn.worker.status');
                    if (status === 'success') {
                        ctx.output({ result: 'completed' });
                        return ctx;
                    }
                    // Don't output anything, keep waiting - this keeps parent in progress
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'spawn-and-wait' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any);
        scheduler.addFlow('parent-flow', parentFlow);
        scheduler.addFlow('long-child-flow', longChildFlow);

        const parentJobId = await scheduler.schedule('parent-flow', { test: 'cancel-parent' });
        
        // Let parent create child and enter blocking state
        for (let i = 0; i < 5; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        // Verify parent is blocking and child exists
        const allJobs = await jobRepo.getAllJobs();
        const parentJob = allJobs.find(j => j.id === parentJobId);
        const childJobs = allJobs.filter(j => j.parent_id === parentJobId);
        
        expect(parentJob?.status).toBe('blocking');
        expect(childJobs).toHaveLength(1);
        expect(['running', 'pending'].includes(childJobs[0].status)).toBe(true);

        // Cancel the parent
        await scheduler.cancel(parentJobId as string);

        // Verify both parent and child are cancelled
        const updatedParent = await jobRepo.getJob(parentJobId as string);
        const updatedChild = await jobRepo.getJob(childJobs[0].id);
        
        expect(updatedParent.status).toBe('cancelled');
        expect(updatedChild.status).toBe('cancelled');
    });

    it('should not cancel parent when child is cancelled, but update spawn status', async () => {
        // Child flow that never completes naturally
        const childFlow = new StateFlow([
            { 
                name: 'work', 
                onState: async ctx => {
                    // Never calls ctx.output() so stays in progress
                    ctx.set('working', true);
                    return ctx;
                }, 
                router: { next: 'work' } // Loop to itself
            },
        ], { startState: 'work' });

        // Parent flow that handles child cancellation
        const parentFlow = new StateFlow([
            { 
                name: 'spawn-and-handle-result', 
                onEnter: async ctx => {
                    // Spawn in onEnter so result is available in onState
                    ctx.spawn('worker', 'child-flow', { work: 'data' });
                    return ctx;
                },
                onState: async ctx => {
                    const status = ctx.get<string>('$spawn.worker.status');
                    if (status === 'cancelled') {
                        ctx.output({ result: 'child was cancelled, parent continues' });
                        return ctx;
                    } else if (status === 'success') {
                        ctx.output({ result: 'child succeeded' });
                        return ctx;
                    }
                    // Still waiting - don't output anything
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'spawn-and-handle-result' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any);
        scheduler.addFlow('parent-flow', parentFlow);
        scheduler.addFlow('child-flow', childFlow);

        const parentJobId = await scheduler.schedule('parent-flow', { test: 'cancel-child' });
        
        // Let parent create child and enter blocking state
        for (let i = 0; i < 3; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        // Find the child job
        const allJobs = await jobRepo.getAllJobs();
        const childJobs = allJobs.filter(j => j.parent_id === parentJobId);
        expect(childJobs).toHaveLength(1);
        const childJobId = childJobs[0].id;

        // Cancel the child (not the parent)
        await scheduler.cancel(childJobId);

        // Let parent process the cancellation
        for (let i = 0; i < 5; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        // Verify child is cancelled but parent completed successfully
        const updatedParent = await jobRepo.getJob(parentJobId as string);
        const updatedChild = await jobRepo.getJob(childJobId);
        
        expect(updatedChild.status).toBe('cancelled');
        expect(updatedParent.status).toBe('done'); // Parent should complete, not be cancelled
        
        const parentContext = StateObject.from(updatedParent.context);
        const output = parentContext.output() as { result: string };
        expect(output.result).toBe('child was cancelled, parent continues');
    });

    it('should clear ephemeral data ($ prefixed keys) when transitioning to next state', async () => {
        // Child flow: simple computation
        const childFlow = new StateFlow([
            { 
                name: 'compute', 
                onState: async ctx => {
                    const input = ctx.input<{value: number}>();
                    ctx.output({ result: input.value * 3 });
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'compute' });

        // Parent flow that demonstrates ephemeral data cleanup
        const parentFlow = new StateFlow([
            { 
                name: 'spawn-and-set-temp-data',
                onState: async ctx => {
                    // Spawn in onState - result will be available in onExit
                    ctx.spawn('computation', 'child-flow', { value: 10 });
                    
                    // Set other ephemeral data that should also be cleared
                    ctx.set('$temp.counter', 42);
                    ctx.set('$cache.lastResult', 'some cached value');
                    ctx.set('normalData', 'this should persist');
                    
                    return ctx;
                },
                onExit: async ctx => {
                    // Should be able to access all $ prefixed data in onExit
                    const spawnStatus = ctx.get<string>('$spawn.computation.status');
                    const tempCounter = ctx.get<number>('$temp.counter');
                    const cachedValue = ctx.get<string>('$cache.lastResult');
                    const normalData = ctx.get<string>('normalData');
                    
                    ctx.set('exitData', {
                        spawnStatus: spawnStatus || 'not-found',
                        tempCounter: tempCounter || -1,
                        cachedValue: cachedValue || 'not-found',
                        normalData: normalData || 'not-found'
                    });
                    return ctx;
                },
                router: { next: 'check-cleared' } 
            },
            { 
                name: 'check-cleared',
                onState: async ctx => {
                    // All $ prefixed data should be cleared when transitioning to next state
                    const spawnStatus = ctx.get<string>('$spawn.computation.status');
                    const tempCounter = ctx.get<number>('$temp.counter');
                    const cachedValue = ctx.get<string>('$cache.lastResult');
                    const normalData = ctx.get<string>('normalData');
                    const exitData = ctx.get<any>('exitData');
                    
                    ctx.output({ 
                        nextState: {
                            spawnStatus: spawnStatus || 'cleared',
                            tempCounter: tempCounter || 'cleared',
                            cachedValue: cachedValue || 'cleared',
                            normalData: normalData || 'cleared'
                        },
                        previousExit: exitData
                    });
                    return ctx;
                },
                router: { next: null } 
            },
        ], { startState: 'spawn-and-set-temp-data' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const scheduler = new SchedulerService(jobRepo as any, redis as any);
        scheduler.addFlow('parent-flow', parentFlow);
        scheduler.addFlow('child-flow', childFlow);

        const parentJobId = await scheduler.schedule('parent-flow', { test: 'cleanup' });
        
        // Process jobs until completion
        for (let attempt = 1; attempt <= 10; attempt++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        const parentJob = await jobRepo.getJob(parentJobId as string);
        expect(parentJob.status).toBe('done');
        
        const parentContext = StateObject.from(parentJob.context);
        const output = parentContext.output() as { 
            nextState: any, 
            previousExit: any 
        };
        
        // All $ prefixed data should have been available in onExit
        expect(output.previousExit.spawnStatus).toBe('success');
        expect(output.previousExit.tempCounter).toBe(42);
        expect(output.previousExit.cachedValue).toBe('some cached value');
        expect(output.previousExit.normalData).toBe('this should persist');
        
        // All $ prefixed data should be cleared in next state, but normal data persists
        expect(output.nextState.spawnStatus).toBe('cleared');
        expect(output.nextState.tempCounter).toBe('cleared');
        expect(output.nextState.cachedValue).toBe('cleared');
        expect(output.nextState.normalData).toBe('this should persist');
    });

    // ===== ESCALATION TESTS =====

    it('should handle job escalation and approval', async () => {
        // Mock EscalationRepo
        class InMemoryEscalationRepo {
            escalations: Record<string, any> = {};
            
            async createEscalation(escalation: any) {
                const id = 'esc-' + Object.keys(this.escalations).length;
                const fullEscalation = {
                    ...escalation,
                    id,
                    status: 'pending',
                    created_at: new Date(),
                    updated_at: new Date(),
                };
                this.escalations[id] = fullEscalation;
                return fullEscalation;
            }
            
            async getEscalation(id: string) {
                if (!this.escalations[id]) throw new Error('Escalation not found');
                return this.escalations[id];
            }
            
            async updateEscalation(id: string, updates: any) {
                if (!this.escalations[id]) throw new Error('Escalation not found');
                this.escalations[id] = { 
                    ...this.escalations[id], 
                    ...updates, 
                    updated_at: new Date() 
                };
                return this.escalations[id];
            }
            
            async listPendingEscalations() {
                return Object.values(this.escalations).filter(e => e.status === 'pending');
            }
        }

        // Workflow that requires approval
        const approvalFlow = new StateFlow([
            { 
                name: 'request-approval', 
                onState: async ctx => {
                    const input = ctx.input<{amount: number, reason: string}>();
                    
                    if (input.amount > 1000) {
                        // Need approval for large amounts
                        const escalationId = ctx.escalate('manager', 
                            `Approval needed for ${input.reason}`, 
                            [
                                { id: 'decision', type: 'approve', label: 'Approve this request?' },
                                { id: 'comments', type: 'comment', label: 'Additional comments' }
                            ]
                        );
                        ctx.set('escalationId', escalationId);
                        return ctx; // Wait for approval
                    } else {
                        // Auto-approve small amounts
                        ctx.output({ approved: true, reason: 'Auto-approved (small amount)' });
                        return ctx;
                    }
                },
                onExit: async ctx => {
                    // Capture escalation result from ephemeral storage before state transition
                    const escalationId = ctx.get<string>('escalationId');
                    if (escalationId) {
                        const decision = ctx.get<boolean>('$escalation.decision');
                        const comments = ctx.get<string>('$escalation.comments');
                        
                        if (decision !== undefined) {
                            ctx.output({
                                escalationResult: {
                                    approved: decision,
                                    comments: comments,
                                    reason: decision ? 'Manager approved' : 'Manager rejected'
                                }
                            });
                        }
                    }
                    return ctx;
                },
                router: { next: 'process-result' } 
            },
            { 
                name: 'process-result', 
                onState: async ctx => {
                    const escalationId = ctx.get<string>('escalationId');
                    if (escalationId) {
                        // Get escalation result from previous state's output
                        const input = ctx.input<any>();
                        const result = input.escalationResult;
                        if (result) {
                            ctx.output({ 
                                approved: result.approved, 
                                reason: result.reason,
                                comments: result.comments 
                            });
                        } else {
                            ctx.output({ 
                                approved: false, 
                                reason: 'No escalation response found' 
                            });
                        }
                    }
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'request-approval' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const escalationRepo = new InMemoryEscalationRepo();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, {}, escalationRepo as any);
        scheduler.addFlow('approval-flow', approvalFlow);

        // Test case: Large amount requiring approval
        const jobId = await scheduler.schedule('approval-flow', { 
            amount: 2500, 
            reason: 'Equipment purchase' 
        });
        
        // Process until job blocks on escalation
        for (let i = 0; i < 3; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        // Verify job is blocking and escalation was created
        const job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('blocking');
        
        const pendingEscalations = await escalationRepo.listPendingEscalations();
        expect(pendingEscalations).toHaveLength(1);
        
        const escalation = pendingEscalations[0];
        expect(escalation.user).toBe('manager');
        expect(escalation.message).toContain('Equipment purchase');
        expect(escalation.inputs).toHaveLength(2);
        expect(escalation.inputs[0].type).toBe('approve');
        expect(escalation.inputs[1].type).toBe('comment');
        // Assert escalation metadata in context
        const ctx = StateObject.from(job.context);
        const meta = ctx.get<any>(`$escalation`);
        expect(meta).toBeTruthy();
        expect(meta.id).toBe(escalation.id);
        expect(meta.user).toBe('manager');
        expect(meta.message).toContain('Equipment purchase');
        expect(meta.status).toBe('pending');

        // Manager approves with comments
        await scheduler.replyToEscalation(escalation.id, {
            decision: true,
            comments: 'Approved after budget review'
        }, 'approved');

        // Process job completion
        for (let i = 0; i < 5; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        // Verify job completed successfully
        const completedJob = await jobRepo.getJob(jobId as string);
        expect(completedJob.status).toBe('done');
        
        const context = StateObject.from(completedJob.context);
        const output = context.output() as { approved: boolean, reason: string, comments: string };
        expect(output.approved).toBe(true);
        expect(output.reason).toBe('Manager approved');
        expect(output.comments).toBe('Approved after budget review');
    });

    it('should handle job escalation and rejection', async () => {
        // Same setup but test rejection path
        class InMemoryEscalationRepo {
            escalations: Record<string, any> = {};
            
            async createEscalation(escalation: any) {
                const id = 'esc-' + Object.keys(this.escalations).length;
                const fullEscalation = {
                    ...escalation,
                    id,
                    status: 'pending',
                    created_at: new Date(),
                    updated_at: new Date(),
                };
                this.escalations[id] = fullEscalation;
                return fullEscalation;
            }
            
            async updateEscalation(id: string, updates: any) {
                if (!this.escalations[id]) throw new Error('Escalation not found');
                this.escalations[id] = { 
                    ...this.escalations[id], 
                    ...updates, 
                    updated_at: new Date() 
                };
                return this.escalations[id];
            }
            
            async listPendingEscalations() {
                return Object.values(this.escalations).filter(e => e.status === 'pending');
            }
        }

        const rejectionFlow = new StateFlow([
            { 
                name: 'request-approval', 
                onState: async ctx => {
                    const escalationId = ctx.escalate('compliance', 
                        'High-risk transaction requires review', 
                        [
                            { id: 'approved', type: 'approve', label: 'Approve transaction?' },
                            { id: 'risk_level', type: 'select', label: 'Risk assessment', 
                              options: { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk' } },
                            { id: 'notes', type: 'comment', label: 'Review notes' }
                        ]
                    );
                    return ctx;
                },
                onExit: async ctx => {
                    // Capture escalation result from ephemeral storage before state transition
                    const approved = ctx.get<boolean>('$escalation.approved');
                    const riskLevel = ctx.get<string>('$escalation.risk_level');
                    const notes = ctx.get<string>('$escalation.notes');
                    
                    if (approved !== undefined) {
                        ctx.output({
                            escalationResult: {
                                decision: approved ? 'approved' : 'rejected',
                                risk_level: riskLevel,
                                notes: notes 
                            }
                        });
                    }
                    return ctx;
                },
                router: { next: 'handle-decision' } 
            },
            { 
                name: 'handle-decision', 
                onState: async ctx => {
                    // Get escalation result from previous state's output
                    const input = ctx.input<any>();
                    const result = input.escalationResult;
                    
                    if (result) {
                        ctx.output({ 
                            decision: result.decision,
                            risk_level: result.risk_level,
                            notes: result.notes 
                        });
                    } else {
                        ctx.output({ 
                            decision: 'no-response',
                            risk_level: 'unknown',
                            notes: 'No escalation response found' 
                        });
                    }
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'request-approval' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const escalationRepo = new InMemoryEscalationRepo();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, {}, escalationRepo as any);
        scheduler.addFlow('rejection-flow', rejectionFlow);

        const jobId = await scheduler.schedule('rejection-flow', { 
            transaction_id: 'tx-123', 
            amount: 50000 
        });
        
        // Process until blocked
        for (let i = 0; i < 3; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        const escalations = await escalationRepo.listPendingEscalations();
        const escalation = escalations[0];
        // Assert escalation metadata in context
        const job = await jobRepo.getJob(jobId as string);
        const ctx = StateObject.from(job.context);
        const meta = ctx.get<any>(`$escalation`);
        expect(meta).toBeTruthy();
        expect(meta.id).toBe(escalation.id);
        expect(meta.user).toBe('compliance');
        expect(meta.message).toContain('High-risk transaction');
        expect(meta.status).toBe('pending');

        // Compliance rejects with explanation
        await scheduler.replyToEscalation(escalation.id, {
            approved: false,
            risk_level: 'high',
            notes: 'Transaction flagged by fraud detection system'
        }, 'rejected');

        // Process completion
        for (let i = 0; i < 5; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        const completedJob = await jobRepo.getJob(jobId as string);
        expect(completedJob.status).toBe('done');
        
        const context = StateObject.from(completedJob.context);
        const output = context.output() as { decision: string, risk_level: string, notes: string };
        expect(output.decision).toBe('rejected');
        expect(output.risk_level).toBe('high');
        expect(output.notes).toContain('fraud detection');
    });

    it('should handle multiple escalations in same job', async () => {
        class InMemoryEscalationRepo {
            escalations: Record<string, any> = {};
            
            async createEscalation(escalation: any) {
                const id = 'esc-' + Object.keys(this.escalations).length;
                this.escalations[id] = {
                    ...escalation,
                    id,
                    status: 'pending',
                    created_at: new Date(),
                    updated_at: new Date(),
                };
                return this.escalations[id];
            }
            
            async updateEscalation(id: string, updates: any) {
                this.escalations[id] = { 
                    ...this.escalations[id], 
                    ...updates, 
                    updated_at: new Date() 
                };
                return this.escalations[id];
            }
            
            async listPendingEscalations() {
                return Object.values(this.escalations).filter(e => e.status === 'pending');
            }
        }

        const multiEscalationFlow = new StateFlow([
            { 
                name: 'financial-review', 
                onState: async ctx => {
                    ctx.escalate('finance', 'Budget approval needed', [
                        { id: 'approved', type: 'approve', label: 'Approve budget?' }
                    ]);
                    return ctx;
                },
                onExit: async ctx => {
                    // Capture escalation result from ephemeral storage before state transition
                    const approved = ctx.get<boolean>('$escalation.approved');
                    
                    if (approved !== undefined) {
                        ctx.output({
                            financeResult: {
                                approved: approved
                            }
                        });
                    }
                    return ctx;
                },
                router: { next: 'legal-review' } 
            },
            { 
                name: 'legal-review', 
                onState: async ctx => {
                    // Get finance result from previous state's output
                    const input = ctx.input<any>();
                    const financeResult = input.financeResult;
                    const financeApproved = financeResult?.approved;
                    
                    if (financeApproved) {
                        ctx.escalate('legal', 'Legal compliance check', [
                            { id: 'compliant', type: 'approve', label: 'Legally compliant?' },
                            { id: 'concerns', type: 'comment', label: 'Legal concerns' }
                        ]);
                        return ctx;
                    } else {
                        ctx.output({ result: 'rejected by finance' });
                        return ctx;
                    }
                },
                onExit: async ctx => {
                    // Capture escalation result from ephemeral storage before state transition
                    const compliant = ctx.get<boolean>('$escalation.compliant');
                    const concerns = ctx.get<string>('$escalation.concerns');
                    
                    if (compliant !== undefined) {
                        ctx.output({
                            legalResult: {
                                compliant: compliant,
                                concerns: concerns
                            }
                        });
                    }
                    return ctx;
                },
                router: { next: 'finalize' } 
            },
            { 
                name: 'finalize', 
                onState: async ctx => {
                    // Get legal result from previous state's output
                    const input = ctx.input<any>();
                    const legalResult = input.legalResult;
                    const legalApproved = legalResult?.compliant;
                    const concerns = legalResult?.concerns;
                    
                    ctx.output({ 
                        result: legalApproved ? 'fully approved' : 'rejected by legal',
                        legal_concerns: concerns 
                    });
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'financial-review' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const escalationRepo = new InMemoryEscalationRepo();
        const scheduler = new SchedulerService(jobRepo as any, redis as any, {}, escalationRepo as any);
        scheduler.addFlow('multi-escalation-flow', multiEscalationFlow);

        const jobId = await scheduler.schedule('multi-escalation-flow', { 
            contract: 'major-partnership-deal' 
        });
        
        // Process until first escalation (finance)
        for (let i = 0; i < 3; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        let escalations = await escalationRepo.listPendingEscalations();
        expect(escalations).toHaveLength(1);
        expect(escalations[0].user).toBe('finance');
        // Assert escalation metadata in context
        let job = await jobRepo.getJob(jobId as string);
        let ctx = StateObject.from(job.context);
        let meta = ctx.get<any>(`$escalation`);
        expect(meta).toBeTruthy();
        expect(meta.id).toBe(escalations[0].id);
        expect(meta.user).toBe('finance');
        expect(meta.message).toContain('Budget approval');
        expect(meta.status).toBe('pending');

        // Finance approves
        await scheduler.replyToEscalation(escalations[0].id, { approved: true }, 'approved');

        // Process until second escalation (legal)
        for (let i = 0; i < 5; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        escalations = await escalationRepo.listPendingEscalations();
        const legalEscalation = escalations.find(e => e.user === 'legal' && e.status === 'pending');
        expect(legalEscalation).toBeTruthy();

        // Legal approves with minor concerns
        await scheduler.replyToEscalation(legalEscalation.id, { 
            compliant: true,
            concerns: 'Minor compliance notes documented' 
        }, 'approved');

        // Process to completion
        for (let i = 0; i < 5; i++) {
            await scheduler.doProcess();
            await scheduler.reviewBlockingJobs();
        }

        const completedJob = await jobRepo.getJob(jobId as string);
        expect(completedJob.status).toBe('done');
        
        const context = StateObject.from(completedJob.context);
        const output = context.output() as { result: string, legal_concerns: string };
        expect(output.result).toBe('fully approved');
        expect(output.legal_concerns).toBe('Minor compliance notes documented');
    });
});

// ===== CONCURRENCY TESTS =====
describe('SchedulerService Concurrency', () => {
    it('should handle multiple scheduler instances without duplicate job processing', async () => {
        // Simple job flow for testing
        const flow = new StateFlow([
            { 
                name: 'work', 
                onState: async ctx => {
                    const input = ctx.input<{jobNumber: number}>();
                    // Simulate some work with a small delay
                    await new Promise(resolve => setTimeout(resolve, 10));
                    ctx.output({ result: `Job ${input.jobNumber} completed` });
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'work' });

        // Shared infrastructure
        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        
        // Create multiple scheduler instances (simulating distributed workers)
        const scheduler1 = new SchedulerService(jobRepo as any, redis as any);
        const scheduler2 = new SchedulerService(jobRepo as any, redis as any);
        const scheduler3 = new SchedulerService(jobRepo as any, redis as any);
        
        // All schedulers use the same flow
        [scheduler1, scheduler2, scheduler3].forEach(s => s.addFlow('concurrent-test', flow));

        // Schedule multiple jobs
        const jobCount = 10;
        const jobIds: string[] = [];
        for (let i = 0; i < jobCount; i++) {
            const jobId = await scheduler1.schedule('concurrent-test', { jobNumber: i });
            jobIds.push(jobId as string);
        }

        // Process jobs concurrently with multiple schedulers
        const processPromises: Promise<void>[] = [];
        for (let i = 0; i < 20; i++) { // More processing attempts than jobs
            processPromises.push(scheduler1.doProcess());
            processPromises.push(scheduler2.doProcess());
            processPromises.push(scheduler3.doProcess());
        }
        
        await Promise.all(processPromises);

        // Verify all jobs completed exactly once
        const allJobs = await jobRepo.getAllJobs();
        const completedJobs = allJobs.filter(job => job.status === 'done');
        expect(completedJobs).toHaveLength(jobCount);

        // Verify no job was processed multiple times by checking unique results
        const results = new Set();
        for (const job of completedJobs) {
            const context = StateObject.from(job.context);
            const output = context.output() as { result: string };
            expect(results.has(output.result)).toBe(false); // No duplicates
            results.add(output.result);
        }

        // Verify Redis job queue is empty (no stuck jobs)
        const queueLength = await redis.llen('job_queue');
        expect(queueLength).toBe(0);
    });

    it('should handle concurrent parent-child job processing', async () => {
        // Child flow
        const childFlow = new StateFlow([
            { 
                name: 'child-work', 
                onState: async ctx => {
                    const input = ctx.input<{childId: number}>();
                    await new Promise(resolve => setTimeout(resolve, 5)); // Small delay
                    ctx.output({ childResult: `Child ${input.childId} done` });
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'child-work' });

        // Parent flow that spawns children
        const parentFlow = new StateFlow([
            { 
                name: 'spawn-children', 
                onState: async ctx => {
                    const input = ctx.input<{parentId: number, childCount: number}>();
                    // Spawn multiple children
                    for (let i = 0; i < input.childCount; i++) {
                        ctx.spawn(`child-${i}`, 'child-flow', { childId: i, parentId: input.parentId });
                    }
                    return ctx;
                },
                onExit: async ctx => {
                    // Collect all child results
                    const input = ctx.input<{parentId: number, childCount: number}>();
                    const childResults: any[] = [];
                    for (let i = 0; i < input.childCount; i++) {
                        const status = ctx.get<string>(`$spawn.child-${i}.status`);
                        const result = ctx.get<any>(`$spawn.child-${i}.result`);
                        if (status === 'success') {
                            childResults.push(result);
                        }
                    }
                    ctx.output({ 
                        parentResult: `Parent ${input.parentId} collected ${childResults.length} results`,
                        childResults 
                    });
                    return ctx;
                },
                router: { next: null } 
            },
        ], { startState: 'spawn-children' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        
        // Multiple scheduler instances
        const schedulers = [
            new SchedulerService(jobRepo as any, redis as any),
            new SchedulerService(jobRepo as any, redis as any),
            new SchedulerService(jobRepo as any, redis as any)
        ];
        
        schedulers.forEach(s => {
            s.addFlow('parent-flow', parentFlow);
            s.addFlow('child-flow', childFlow);
        });

        // Schedule parent jobs that will spawn children
        const parentCount = 3;
        const childrenPerParent = 2;
        const parentJobIds: string[] = [];
        
        for (let i = 0; i < parentCount; i++) {
            const jobId = await schedulers[0].schedule('parent-flow', { 
                parentId: i, 
                childCount: childrenPerParent 
            });
            parentJobIds.push(jobId as string);
        }

        // Process jobs concurrently with multiple schedulers
        // Keep processing until all jobs are done
        let maxAttempts = 50;
        let attempt = 0;
        
        while (attempt < maxAttempts) {
            const processPromises = schedulers.map(s => Promise.all([
                s.doProcess(),
                s.reviewBlockingJobs()
            ]));
            await Promise.all(processPromises);
            
            // Check if all parent jobs are complete
            const allJobs = await jobRepo.getAllJobs();
            const parentJobs = allJobs.filter(job => parentJobIds.includes(job.id));
            const completedParents = parentJobs.filter(job => job.status === 'done');
            
            if (completedParents.length === parentCount) {
                break; // All parents completed
            }
            
            attempt++;
        }

        // Verify all parent jobs completed
        const allJobs = await jobRepo.getAllJobs();
        const parentJobs = allJobs.filter(job => parentJobIds.includes(job.id));
        const completedParents = parentJobs.filter(job => job.status === 'done');
        expect(completedParents).toHaveLength(parentCount);

        // Verify all child jobs completed
        const childJobs = allJobs.filter(job => job.parent_id && parentJobIds.includes(job.parent_id));
        const completedChildren = childJobs.filter(job => job.status === 'done');
        expect(completedChildren).toHaveLength(parentCount * childrenPerParent);

        // Verify parent results include all child results
        for (const parentJob of completedParents) {
            const context = StateObject.from(parentJob.context);
            const output = context.output() as { parentResult: string, childResults: any[] };
            expect(output.childResults).toHaveLength(childrenPerParent);
        }

        // Verify no jobs are stuck in queues
        expect(await redis.llen('job_queue')).toBe(0);
        expect(await redis.llen('blocking_jobs')).toBe(0);
    });

    it('should handle rapid job scheduling and processing without race conditions', async () => {
        // Fast simple flow
        const flow = new StateFlow([
            { 
                name: 'fast-work', 
                onState: async ctx => {
                    const input = ctx.input<{id: number}>();
                    ctx.output({ processed: `job-${input.id}` });
                    return ctx;
                }, 
                router: { next: null } 
            },
        ], { startState: 'fast-work' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        
        // Multiple scheduler instances
        const schedulers = [
            new SchedulerService(jobRepo as any, redis as any),
            new SchedulerService(jobRepo as any, redis as any),
            new SchedulerService(jobRepo as any, redis as any),
            new SchedulerService(jobRepo as any, redis as any)
        ];
        
        schedulers.forEach(s => s.addFlow('fast-flow', flow));

        // Rapidly schedule many jobs from multiple schedulers simultaneously
        const jobCount = 50;
        const schedulingPromises: Promise<any>[] = [];
        
        for (let i = 0; i < jobCount; i++) {
            const schedulerIndex = i % schedulers.length;
            schedulingPromises.push(
                schedulers[schedulerIndex].schedule('fast-flow', { id: i })
            );
        }
        
        // Wait for all jobs to be scheduled
        const jobIds = await Promise.all(schedulingPromises);

        // Process with multiple schedulers aggressively
        let attempts = 0;
        const maxAttempts = 100;
        
        while (attempts < maxAttempts) {
            const promises: Promise<void>[] = [];
            schedulers.forEach(scheduler => {
                promises.push(scheduler.doProcess());
            });
            await Promise.all(promises);
            
            // Check completion
            const allJobs = await jobRepo.getAllJobs();
            const completed = allJobs.filter(job => job.status === 'done');
            const running = allJobs.filter(job => job.status === 'running');
            const pending = allJobs.filter(job => job.status === 'pending');
            const failed = allJobs.filter(job => job.status === 'failed');
            
            console.log(`Attempt ${attempts + 1}: done=${completed.length}, running=${running.length}, pending=${pending.length}, failed=${failed.length}`);
            
            if (completed.length === jobCount) {
                break;
            }
            attempts++;
        }

        // Verify all jobs completed exactly once
        const allJobs = await jobRepo.getAllJobs();
        expect(allJobs).toHaveLength(jobCount);
        
        const completedJobs = allJobs.filter(job => job.status === 'done');
        expect(completedJobs).toHaveLength(jobCount);

        // Verify each job processed exactly once with unique output
        const processedIds = new Set();
        for (const job of completedJobs) {
            const context = StateObject.from(job.context);
            const output = context.output() as { processed: string };
            expect(processedIds.has(output.processed)).toBe(false);
            processedIds.add(output.processed);
        }

        // Verify Redis queues are clean
        expect(await redis.llen('job_queue')).toBe(0);
    });

    it('should handle job status update race conditions', async () => {
        // Flow that can potentially create race conditions in status updates
        const flow = new StateFlow([
            { 
                name: 'state1', 
                onState: async ctx => {
                    const input = ctx.input<{value: number}>();
                    // Small delay to increase chance of race conditions
                    await new Promise(resolve => setTimeout(resolve, 1));
                    // Pass input through to next state
                    ctx.output(input);
                    return ctx;
                },
                router: { next: 'state2' }
            },
            { 
                name: 'state2', 
                onState: async ctx => {
                    const input = ctx.input<{value: number}>();
                    await new Promise(resolve => setTimeout(resolve, 1));
                    ctx.output({ final: input.value * 2 });
                    return ctx;
                },
                router: { next: null }
            }
        ], { startState: 'state1' });

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        
        // Multiple schedulers
        const schedulers = [
            new SchedulerService(jobRepo as any, redis as any),
            new SchedulerService(jobRepo as any, redis as any),
            new SchedulerService(jobRepo as any, redis as any)
        ];
        
        schedulers.forEach(s => s.addFlow('multi-state-flow', flow));

        // Schedule jobs
        const jobCount = 20;
        const jobIds: string[] = [];
        for (let i = 0; i < jobCount; i++) {
            const jobId = await schedulers[0].schedule('multi-state-flow', { value: i });
            jobIds.push(jobId as string);
        }

        // Ensure all jobs are queued to Redis
        await Promise.all(schedulers.map(s => s.runPendingJobs(50)));

        // Process with multiple schedulers aggressively
        let attempts = 0;
        const maxAttempts = 100;
        
        while (attempts < maxAttempts) {
            const promises: Promise<void>[] = [];
            schedulers.forEach(scheduler => {
                promises.push(scheduler.doProcess());
            });
            await Promise.all(promises);
            
            // Check completion
            const allJobs = await jobRepo.getAllJobs();
            const completed = allJobs.filter(job => job.status === 'done');
            if (completed.length === jobCount) {
                break;
            }
            attempts++;
        }

        // Verify all jobs completed successfully
        const allJobs = await jobRepo.getAllJobs();
        const completedJobs = allJobs.filter(job => job.status === 'done');
        expect(completedJobs).toHaveLength(jobCount);

        // Verify no jobs are in inconsistent states
        const failedJobs = allJobs.filter(job => job.status === 'failed');
        expect(failedJobs).toHaveLength(0);

        const runningJobs = allJobs.filter(job => job.status === 'running');
        expect(runningJobs).toHaveLength(0);

        // Verify outputs are correct
        for (const job of completedJobs) {
            const context = StateObject.from(job.context);
            const output = context.output() as { final: number };
            const originalIndex = jobIds.indexOf(job.id);
            expect(output.final).toBe(originalIndex * 2);
        }
    });

    it('should handle escalation concurrency without conflicts', async () => {
        // Flow with escalation
        const escalationFlow = new StateFlow([
            { 
                name: 'needs-approval', 
                onState: async ctx => {
                    const input = ctx.input<{requestId: number}>();
                    ctx.escalate('manager', `Request ${input.requestId} needs approval`, [
                        { id: 'approved', type: 'approve', label: 'Approve?' }
                    ]);
                    return ctx;
                },
                onExit: async ctx => {
                    const approved = ctx.get<boolean>('$escalation.approved');
                    ctx.output({ 
                        approved: approved || false, 
                        processed: true 
                    });
                    return ctx;
                },
                router: { next: null }
            }
        ], { startState: 'needs-approval' });

        class InMemoryEscalationRepo {
            escalations: Record<string, any> = {};
            counter = 0;

            async createEscalation(escalation: any) {
                const id = `esc-${++this.counter}`;
                this.escalations[id] = { 
                    ...escalation, 
                    id,
                    status: 'pending',
                    created_at: new Date()
                };
                return this.escalations[id];
            }

            async getEscalation(id: string) {
                return this.escalations[id] || null;
            }

            async updateEscalation(id: string, updates: any) {
                if (this.escalations[id]) {
                    this.escalations[id] = { ...this.escalations[id], ...updates };
                    return this.escalations[id];
                }
                throw new Error('Escalation not found');
            }

            async listPendingEscalations() {
                return Object.values(this.escalations).filter((e: any) => e.status === 'pending');
            }
        }

        const jobRepo = new InMemoryJobRepo();
        const redis = new InMemoryRedis();
        const escalationRepo = new InMemoryEscalationRepo();
        
        // Multiple schedulers with escalation support
        const schedulers = [
            new SchedulerService(jobRepo as any, redis as any, {}, escalationRepo as any),
            new SchedulerService(jobRepo as any, redis as any, {}, escalationRepo as any),
            new SchedulerService(jobRepo as any, redis as any, {}, escalationRepo as any)
        ];
        
        schedulers.forEach(s => s.addFlow('escalation-flow', escalationFlow));

        // Schedule multiple jobs that will create escalations
        const jobCount = 10;
        const jobIds: string[] = [];
        for (let i = 0; i < jobCount; i++) {
            const jobId = await schedulers[0].schedule('escalation-flow', { requestId: i });
            jobIds.push(jobId as string);
        }

        // Ensure all jobs are queued to Redis
        await Promise.all(schedulers.map(s => s.runPendingJobs(50)));

        // Process jobs to create escalations
        for (let i = 0; i < 20; i++) {
            const promises = schedulers.map(s => s.doProcess());
            await Promise.all(promises);
        }

        // Verify escalations were created
        const pendingEscalations = await escalationRepo.listPendingEscalations();
        expect(pendingEscalations).toHaveLength(jobCount);

        // Approve all escalations concurrently
        const approvalPromises = pendingEscalations.map((esc: any) =>
            schedulers[0].replyToEscalation(esc.id, { approved: true }, 'approved')
        );
        await Promise.all(approvalPromises);

        // Process jobs to completion
        let attempts = 0;
        while (attempts < 50) {
            const promises = schedulers.map(s => s.doProcess());
            await Promise.all(promises);
            
            const allJobs = await jobRepo.getAllJobs();
            const completed = allJobs.filter(job => job.status === 'done');
            if (completed.length === jobCount) {
                break;
            }
            attempts++;
        }

        // Verify all jobs completed successfully
        const allJobs = await jobRepo.getAllJobs();
        const completedJobs = allJobs.filter(job => job.status === 'done');
        expect(completedJobs).toHaveLength(jobCount);

        // Verify all approvals processed correctly
        for (const job of completedJobs) {
            const context = StateObject.from(job.context);
            const output = context.output() as { approved: boolean, processed: boolean };
            expect(output.approved).toBe(true);
            expect(output.processed).toBe(true);
        }
    });
});

// ===== START/STOP EDGE CASE TESTS =====
describe('SchedulerService Start/Stop Edge Cases', () => {
    let jobRepo: InMemoryJobRepo;
    let redis: InMemoryRedis;
    let scheduler: SchedulerService;

    beforeEach(() => {
        jobRepo = new InMemoryJobRepo();
        redis = new InMemoryRedis();
        scheduler = new SchedulerService(jobRepo as any, redis as any);
    });

    afterEach(() => {
        // Always stop to clean up timers
        scheduler.stop();
    });

    it('should handle multiple start() calls gracefully', async () => {
        // Start should be idempotent - multiple calls should not create duplicate timers
        
        // Start first time
        scheduler.start(100);
        
        // Start second time - should not create new timers or throw error
        expect(() => scheduler.start(50)).not.toThrow();
        
        // Verify scheduler still works by processing a simple job
        const flow = new StateFlow([
            { name: 'test', onState: async ctx => { ctx.output({ done: true }); return ctx; } }
        ], { startState: 'test' });
        scheduler.addFlow('test-flow', flow);
        
        const jobId = await scheduler.schedule('test-flow', { test: true });
        
        // Wait a bit for automatic processing
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('done');
    });

    it('should handle stop() called before start()', () => {
        // Stop without start should not throw error
        expect(() => scheduler.stop()).not.toThrow();
    });

    it('should handle multiple stop() calls', () => {
        scheduler.start(100);
        
        // First stop
        expect(() => scheduler.stop()).not.toThrow();
        
        // Second stop should not throw
        expect(() => scheduler.stop()).not.toThrow();
    });

    it('should allow restart after stop', async () => {
        const flow = new StateFlow([
            { name: 'test', onState: async ctx => { ctx.output({ processed: true }); return ctx; } }
        ], { startState: 'test' });
        scheduler.addFlow('restart-test', flow);

        // Start, stop, then start again
        scheduler.start(100);
        scheduler.stop();
        scheduler.start(100);
        
        // Should still work after restart
        const jobId = await scheduler.schedule('restart-test', { data: 'test' });
        
        // Wait for automatic processing
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('done');
    });

    it('should process jobs automatically with different intervals', async () => {
        const flow = new StateFlow([
            { name: 'auto', onState: async ctx => { ctx.output({ auto: true }); return ctx; } }
        ], { startState: 'auto' });
        scheduler.addFlow('auto-test', flow);

        // Start with very fast interval
        scheduler.start(10);
        
        const jobId = await scheduler.schedule('auto-test', { speed: 'fast' });
        
        // Should process quickly
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('done');
    });

    it('should handle timer cleanup properly on stop', async () => {
        // This test verifies that stop() actually clears all timers
        // We can't directly test timer cleanup, but we can verify no processing happens after stop
        
        const flow = new StateFlow([
            { name: 'cleanup', onState: async ctx => { ctx.output({ result: 'processed' }); return ctx; } }
        ], { startState: 'cleanup' });
        scheduler.addFlow('cleanup-test', flow);

        scheduler.start(50);
        
        // Schedule a job but stop immediately
        const jobId = await scheduler.schedule('cleanup-test', { test: 'cleanup' });
        scheduler.stop();
        
        // Wait longer than the interval
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Job should still be pending since timers were stopped
        const job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('pending');
    });

    it('should handle concurrent start and stop calls', async () => {
        // Test race conditions between start and stop
        const promises: Promise<void>[] = [];
        
        // Start multiple concurrent start/stop operations
        for (let i = 0; i < 10; i++) {
            promises.push(
                new Promise<void>((resolve) => {
                    if (i % 2 === 0) {
                        scheduler.start(100);
                    } else {
                        scheduler.stop();
                    }
                    resolve();
                })
            );
        }
        
        // Should not throw any errors
        await expect(Promise.all(promises)).resolves.toBeDefined();
    });

    it('should handle start with zero interval', async () => {
        const flow = new StateFlow([
            { name: 'zero', onState: async ctx => { ctx.output({ zero: true }); return ctx; } }
        ], { startState: 'zero' });
        scheduler.addFlow('zero-test', flow);

        // Start with zero interval (immediate execution)
        scheduler.start(0);
        
        const jobId = await scheduler.schedule('zero-test', { interval: 0 });
        
        // Should process very quickly
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('done');
    });

    it('should continue automatic processing of blocking jobs', async () => {
        class InMemoryEscalationRepo {
            escalations: Record<string, any> = {};
            counter = 0;

            async createEscalation(escalation: any) {
                const id = `esc-${++this.counter}`;
                this.escalations[id] = { 
                    ...escalation, 
                    id,
                    status: 'pending',
                    created_at: new Date()
                };
                return this.escalations[id];
            }

            async updateEscalation(id: string, updates: any) {
                if (this.escalations[id]) {
                    this.escalations[id] = { ...this.escalations[id], ...updates };
                    return this.escalations[id];
                }
                throw new Error('Escalation not found');
            }
        }

        const escalationRepo = new InMemoryEscalationRepo();
        const blockingScheduler = new SchedulerService(jobRepo as any, redis as any, {}, escalationRepo as any);

        const flow = new StateFlow([
            { 
                name: 'blocking-state', 
                onState: async ctx => {
                    // Create an escalation that blocks the job
                    ctx.escalate('approver', 'Auto-test approval needed', [
                        { id: 'approved', type: 'approve', label: 'Approve?' }
                    ]);
                    return ctx;
                },
                onExit: async ctx => {
                    const approved = ctx.get<boolean>('$escalation.approved');
                    ctx.output({ approved: approved || false });
                    return ctx;
                },
                router: { next: null }
            }
        ], { startState: 'blocking-state' });
        blockingScheduler.addFlow('blocking-test', flow);

        blockingScheduler.start(50);
        
        const jobId = await blockingScheduler.schedule('blocking-test', { test: 'blocking' });
        
        // Wait for job to reach blocking state
        await new Promise(resolve => setTimeout(resolve, 100));
        
        let job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('blocking');
        
        // Get the escalation and approve it
        const escalations = await escalationRepo.escalations;
        const escalationId = Object.keys(escalations)[0];
        await blockingScheduler.replyToEscalation(escalationId, { approved: true }, 'approved');
        
        // Wait for automatic review to pick it up
        await new Promise(resolve => setTimeout(resolve, 100));
        
        job = await jobRepo.getJob(jobId as string);
        expect(job.status).toBe('done');
        
        blockingScheduler.stop();
    });

    it('should automatically queue pending jobs via interval', async () => {
        const flow = new StateFlow([
            { name: 'pending', onState: async ctx => { ctx.output({ queued: true }); return ctx; } }
        ], { startState: 'pending' });
        scheduler.addFlow('pending-test', flow);

        // Create job directly in repo without queuing to Redis (simulates orphaned job)
        const orphanJob = await jobRepo.createJob({
            flow: 'pending-test',
            status: 'pending',
            context: scheduler.flow('pending-test').newContext({ orphaned: true }).serialize(),
            retries: 0,
        });

        scheduler.start(50);
        
        // Wait for automatic pending job processing
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const job = await jobRepo.getJob(orphanJob.id);
        expect(job.status).toBe('done');
    });

    it('should handle orphaned job cleanup automatically', async () => {
        // Create a simple flow for the stuck job (but one that won't complete)
        const testFlow = new StateFlow([
            { name: 'stuck', onState: async ctx => { 
                // This job will never complete because it never outputs anything
                return ctx; 
            }, router: { next: 'stuck' } } // Infinite loop
        ], { startState: 'stuck' });
        scheduler.addFlow('stuck-flow', testFlow);

        // Create a job that's stuck in running state for too long
        const stuckJob = await jobRepo.createJob({
            flow: 'stuck-flow',
            status: 'running',
            context: testFlow.newContext({}).serialize(),
            retries: 3, // Set to max retries so it will be marked as failed
            startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        });

        // Manually call cleanup with a short max age (1 hour instead of default)
        await scheduler.cleanupOrphanedJobs(60 * 60 * 1000); // 1 hour
        
        const job = await jobRepo.getJob(stuckJob.id);
        expect(job.status).toBe('failed');
    });
}); 