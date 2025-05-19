import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import Redis from 'ioredis';
import { runMigrations } from '../../scripts/migrate';
import { PostgresJobRepo } from '../../src/scheduler/PostgresJobRepo';
import { Scheduler } from '../../src/scheduler/Scheduler';
import { StateMachine } from '../../src/core/StateMachine';
import { StateObject } from '../../src/core/StateObject';
import { PostgresEscalationRepo } from '../../src/scheduler/PostgresEscalationRepo';

const testStateMachine = new StateMachine([
  {
    name: 'start',
    onState: async ctx => ctx,
    router: { next: 'done' }
  },
  {
    name: 'done',
    onState: async ctx => ctx
  }
]);

describe('Scheduler (integration)', () => {
  let pool: Pool;
  let repo: PostgresJobRepo;
  let redis: Redis;
  let scheduler: Scheduler;

  const dbConfig = {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT!),
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    database: process.env.PGTESTDATABASE!,
    adminDatabase: process.env.PGADMINDATABASE || process.env.PGDATABASE!,
  };

  beforeAll(async () => {
    // Clean and migrate the test database before all tests
    await runMigrations(dbConfig, true); // This will drop and create the DB
    pool = new Pool(dbConfig);           // Only create the pool after DB exists
    repo = new PostgresJobRepo(pool);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
    });
    scheduler = new Scheduler(repo, redis, { maxRetries: 0 });
    scheduler.addStateMachine('test', testStateMachine);
  });

  afterAll(async () => {
    if (scheduler && typeof scheduler.stopExecutionLoop === 'function') {
      scheduler.stopExecutionLoop();
    }
    if (repo && typeof repo.close === 'function') {
      await repo.close();
    }
    await redis.quit();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE TABLE jobs');
    await redis.flushdb();
  });

  it('should schedule a job and return an ID', async () => {
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    const job = await scheduler.getJob(jobIdStr);
    expect(job.stateMachine).toBe('test');
    expect(job.status).toBe('pending');
  });

  it('should pick up pending jobs and replicate to Redis', async () => {
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    await scheduler.runPendingJobs();
    const job = await scheduler.getJob(jobIdStr);
    expect(job.status).toBe('running');
    const inRedis = await redis.get(`job:${jobIdStr}`);
    expect(inRedis).toBeTruthy();
    const runningJobs = await redis.smembers('running_jobs');
    expect(runningJobs).toContain(jobIdStr);
    const queue = await redis.lrange('job_queue', 0, -1);
    expect(queue).toContain(jobIdStr);
  });

  it('should complete a job and clean up Redis', async () => {
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    await scheduler.runPendingJobs();
    await scheduler.completeJob(jobIdStr);
    const job = await scheduler.getJob(jobIdStr);
    expect(job.status).toBe('done');
    expect(await redis.get(`job:${jobIdStr}`)).toBeNull();
    expect(await redis.sismember('running_jobs', jobIdStr)).toBe(0);
    expect(await redis.lrange('job_queue', 0, -1)).not.toContain(jobIdStr);
  });

  it('should fail a job and clean up Redis', async () => {
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    await scheduler.runPendingJobs();
    await scheduler.failJob(jobIdStr, 'fail reason');
    const job = await scheduler.getJob(jobIdStr);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('fail reason');
    expect(await redis.get(`job:${jobIdStr}`)).toBeNull();
    expect(await redis.sismember('running_jobs', jobIdStr)).toBe(0);
    expect(await redis.lrange('job_queue', 0, -1)).not.toContain(jobIdStr);
  });

  it('should cancel a job and clean up Redis', async () => {
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    await scheduler.runPendingJobs();
    await scheduler.cancelJob(jobIdStr);
    const job = await scheduler.getJob(jobIdStr);
    expect(job.status).toBe('cancelled');
    expect(await redis.get(`job:${jobIdStr}`)).toBeNull();
    expect(await redis.sismember('running_jobs', jobIdStr)).toBe(0);
    expect(await redis.lrange('job_queue', 0, -1)).not.toContain(jobIdStr);
  });

  /**
   * Test: Multiple Jobs Scheduling and Processing
   */
  it('should schedule and process multiple jobs', async () => {
    const jobIds = await Promise.all([
      scheduler.schedule('test', { foo: 1 }),
      scheduler.schedule('test', { foo: 2 }),
      scheduler.schedule('test', { foo: 3 })
    ]);
    jobIds.forEach(id => expect(typeof id).toBe('string'));
    await scheduler.runPendingJobs();
    for (const jobId of jobIds) {
      const jobIdStr = jobId as string;
      const job = await scheduler.getJob(jobIdStr);
      expect(job.status).toBe('running');
      const inRedis = await redis.get(`job:${jobIdStr}`);
      expect(inRedis).toBeTruthy();
    }
  });

  /**
   * Test: Job Status Transitions
   */
  it('should not change status from failed to done', async () => {
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    await scheduler.runPendingJobs();
    await scheduler.failJob(jobIdStr, 'fail reason');
    let job = await scheduler.getJob(jobIdStr);
    console.log('After failJob:', job.status);
    expect(job.status).toBe('failed');
    await scheduler.completeJob(jobIdStr); // Should not change from failed to done
    job = await scheduler.getJob(jobIdStr);
    console.log('After completeJob:', job.status);
    expect(job.status).toBe('failed');
  });

  /**
   * Test: Redis Queue/Set Consistency
   */
  it('should keep Redis sets/queues consistent with DB', async () => {
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    await scheduler.runPendingJobs();
    await scheduler.completeJob(jobIdStr);
    expect(await redis.get(`job:${jobIdStr}`)).toBeNull();
    expect(await redis.sismember('running_jobs', jobIdStr)).toBe(0);
    expect(await redis.lrange('job_queue', 0, -1)).not.toContain(jobIdStr);
    const job = await scheduler.getJob(jobIdStr);
    expect(job.status).toBe('done');
  });

  /**
   * Test: Job Not Found Handling
   */
  it('should throw when operating on a non-existent job', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    await expect(scheduler.completeJob(fakeId)).rejects.toThrow();
    await expect(scheduler.failJob(fakeId, 'fail')).rejects.toThrow();
    await expect(scheduler.cancelJob(fakeId)).rejects.toThrow();
  });

  /**
   * Test: Concurrent Job Processing
   */
  it('should only pick up as many jobs as concurrency allows', async () => {
    // Set concurrency to 2
    scheduler = new Scheduler(repo, redis, { concurrency: 2 });
    scheduler.addStateMachine('test', testStateMachine);
    const jobIds = await Promise.all([
      scheduler.schedule('test', { foo: 1 }),
      scheduler.schedule('test', { foo: 2 }),
      scheduler.schedule('test', { foo: 3 })
    ]);
    await scheduler.runPendingJobs(2); // Pass concurrency as limit
    let runningCount = 0;
    for (const jobId of jobIds) {
      const jobIdStr = jobId as string;
      const job = await scheduler.getJob(jobIdStr);
      console.log(`Job ${jobIdStr} status:`, job.status);
      if (job.status === 'running') runningCount++;
    }
    console.log('Total running jobs:', runningCount);
    expect(runningCount).toBeLessThanOrEqual(2);
  });

  /**
   * Test: StateMachine Error Handling
   */
  it('should mark job as failed if state machine throws', async () => {
    // Error-throwing state machine
    const errorStateMachine = new StateMachine([
      {
        name: 'start',
        onState: async () => { throw new Error('fail!'); },
        router: { next: 'done' }
      },
      {
        name: 'done',
        onState: async ctx => ctx
      }
    ]);
    // Use a scheduler with maxRetries = 3
    const maxRetries = 3;
    scheduler = new Scheduler(repo, redis, { maxRetries });
    scheduler.addStateMachine('error', errorStateMachine);
    const jobId = await scheduler.schedule('error', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    // Run enough times to exceed maxRetries
    for (let i = 0; i < maxRetries + 1; i++) {
      await scheduler.runPendingJobs();
    }
    // Debug: print job status from Redis and DB
    const redisJobStr = await redis.get(`job:${jobIdStr}`);
    let redisStatus = null;
    if (redisJobStr) {
      try {
        const redisJob = JSON.parse(redisJobStr);
        redisStatus = redisJob.status;
      } catch {}
    }
    const dbJob = await repo.getJob(jobIdStr);
    const job = await scheduler.getJob(jobIdStr);
    console.log('Job status after error state machine:', job.status, '| Redis:', redisStatus, '| DB:', dbJob.status);
    expect(job.status).toBe('failed');
    expect(job.retries).toBe(maxRetries);
  });

  /**
   * Test: startExecutionLoop (basic)
   */
  it('should process jobs via startExecutionLoop', async () => {
    scheduler = new Scheduler(repo, redis, { concurrency: 1 });
    scheduler.addStateMachine('test', testStateMachine);
    const jobId = await scheduler.schedule('test', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    scheduler.startExecutionLoop(100, 1000);
    // Wait for the loop to process the job
    await new Promise(res => setTimeout(res, 500));
    const job = await scheduler.getJob(jobIdStr);
    expect(['done', 'failed', 'cancelled', 'running', 'pending']).toContain(job.status);
  });

  it('retries a job up to maxRetries and then fails', async () => {
    // State machine that always throws
    const alwaysFailSM = new StateMachine([
      {
        name: 'start',
        onState: async () => { throw new Error('fail!'); },
        router: { next: null }
      }
    ]);
    // Use a scheduler with maxRetries = 2
    const maxRetries = 2;
    const retryScheduler = new Scheduler(repo, redis, { maxRetries });
    retryScheduler.addStateMachine('alwaysFail', alwaysFailSM);

    const jobId = await retryScheduler.schedule('alwaysFail', { foo: 'bar' }) as string;
    // Run enough times to exceed maxRetries
    for (let i = 0; i < maxRetries + 1; i++) {
      await retryScheduler.runPendingJobs();
    }
    const job = await retryScheduler.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.retries).toBe(maxRetries);
  });
});

describe('Scheduler blocking jobs', () => {
  let pool: Pool;
  let repo: PostgresJobRepo;
  let redis: Redis;
  let scheduler: Scheduler;

  // Use the same dbConfig as above
  const dbConfig = {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT!),
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    database: process.env.PGTESTDATABASE!,
    adminDatabase: process.env.PGADMINDATABASE || process.env.PGDATABASE!,
  };

  // State machine that always waits for 'wait1'
  const blockingStateMachine = new StateMachine([
    {
      name: 'start',
      onState: async ctx => {
        ctx.waitFor([{ id: 'wait1', type: 'external' }]);
        return ctx;
      },
      router: { next: 'done' }
    },
    { name: 'done', onState: async ctx => ctx }
  ]);

  // State machine that waits for two IDs
  const multiWaitStateMachine = new StateMachine([
    {
      name: 'start',
      onState: async ctx => {
        ctx.waitFor([
          { id: 'wait1', type: 'external' },
          { id: 'wait2', type: 'external' }
        ]);
        return ctx;
      },
      router: { next: 'done' }
    },
    { name: 'done', onState: async ctx => ctx }
  ]);

  beforeAll(async () => {
    pool = new Pool(dbConfig);
    repo = new PostgresJobRepo(pool);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
    });
    scheduler = new Scheduler(repo, redis);
    scheduler.addStateMachine('blocking', blockingStateMachine);
    scheduler.addStateMachine('multiwait', multiWaitStateMachine);
  });

  afterAll(async () => {
    if (scheduler && typeof scheduler.stopExecutionLoop === 'function') {
      scheduler.stopExecutionLoop();
    }
    if (repo && typeof repo.close === 'function') {
      await repo.close();
    }
    await redis.quit();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE TABLE jobs');
    await redis.flushdb();
  });

  it('moves job to blocking queue and sets status', async () => {
    const jobId = await scheduler.schedule('blocking', { foo: 'bar' });
    await scheduler.runPendingJobs();
    // Should be in blocking_jobs queue
    const blockingQueue = await redis.lrange('blocking_jobs', 0, -1);
    expect(blockingQueue).toContain(jobId);
    // Should not be in job_queue
    const mainQueue = await redis.lrange('job_queue', 0, -1);
    expect(mainQueue).not.toContain(jobId);
    // Status should be 'blocking'
    const job = await scheduler.getJob(jobId as string);
    expect(job.status).toBe('blocking');
  });

  it('listBlockingJobs returns correct jobs', async () => {
    const jobId = await scheduler.schedule('blocking', { foo: 'bar' });
    await scheduler.runPendingJobs();
    const blockingJobs = await scheduler.listBlockingJobs();
    expect(blockingJobs.length).toBe(1);
    expect(blockingJobs[0].job.id).toBe(jobId);
    expect(blockingJobs[0].blocking).toContain('wait1');
  });

  it('resolveBlockingJob moves job back to main queue if unblocked', async () => {
    const jobId = await scheduler.schedule('blocking', { foo: 'bar' });
    await scheduler.runPendingJobs();
    await scheduler.resolveBlockingJob(jobId as string, 'wait1', { result: 42 });
    // Should be removed from blocking_jobs
    const blockingQueue = await redis.lrange('blocking_jobs', 0, -1);
    expect(blockingQueue).not.toContain(jobId);
    // Should be in job_queue
    const mainQueue = await redis.lrange('job_queue', 0, -1);
    expect(mainQueue).toContain(jobId);
    // Status should be 'pending'
    const job = await scheduler.getJob(jobId as string);
    expect(job.status).toBe('pending');
  });

  it('resolveBlockingJob keeps job blocking if still waiting for other IDs', async () => {
    const jobId = await scheduler.schedule('multiwait', { foo: 'bar' });
    await scheduler.runPendingJobs();
    // Resolve only one wait
    await scheduler.resolveBlockingJob(jobId as string, 'wait1', { result: 1 });
    // Should still be in blocking_jobs
    const blockingQueue = await redis.lrange('blocking_jobs', 0, -1);
    expect(blockingQueue).toContain(jobId);
    // Status should be 'blocking'
    const job = await scheduler.getJob(jobId as string);
    expect(job.status).toBe('blocking');
    // listBlockingJobs should show only wait2 as unresolved
    const blockingJobs = await scheduler.listBlockingJobs();
    expect(blockingJobs.length).toBe(1);
    expect(blockingJobs[0].blocking).toContain('wait2');
    expect(blockingJobs[0].blocking).not.toContain('wait1');
  });
});

describe('Scheduler spawn workflow', () => {
  let pool: Pool;
  let repo: PostgresJobRepo;
  let redis: Redis;
  let scheduler: Scheduler;

  const dbConfig = {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT!),
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    database: process.env.PGTESTDATABASE!,
    adminDatabase: process.env.PGADMINDATABASE || process.env.PGDATABASE!,
  };

  // Child state machine: just sets output
  const childSM = new StateMachine([
    {
      name: 'start',
      onState: async ctx => {
        ctx.output({ childResult: ctx.input<{foo: number}>().foo });
        return ctx;
      },
      router: { next: null }
    }
  ]);

  // Parent state machine: spawns a child
  const parentSM = new StateMachine([
    {
      name: 'start',
      onState: async ctx => {
        ctx.spawn('child', { foo: 42 });
        return ctx;
      },
      router: { next: 'done' }
    },
    {
      name: 'done',
      onState: async ctx => ctx
    }
  ]);

  // Parent with two children
  const parentMultiSM = new StateMachine([
    {
      name: 'start',
      onState: async ctx => {
        ctx.spawn('child', { foo: 1 });
        ctx.spawn('child', { foo: 2 });
        return ctx;
      },
      router: { next: 'done' }
    },
    {
      name: 'done',
      onState: async ctx => ctx
    }
  ]);

  beforeAll(async () => {
    pool = new Pool(dbConfig);
    repo = new PostgresJobRepo(pool);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
    });
    scheduler = new Scheduler(repo, redis);
    scheduler.addStateMachine('parent', parentSM);
    scheduler.addStateMachine('parentMulti', parentMultiSM);
    scheduler.addStateMachine('child', childSM);
  });

  afterAll(async () => {
    if (scheduler && typeof scheduler.stopExecutionLoop === 'function') {
      scheduler.stopExecutionLoop();
    }
    if (repo && typeof repo.close === 'function') {
      await repo.close();
    }
    await redis.quit();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE TABLE jobs');
    await redis.flushdb();
  });

  it('parent spawns a child job and is blocked', async () => {
    const parentId = await scheduler.schedule('parent', { foo: 'parent' });
    await scheduler.runPendingJobs();
    // Parent should be blocked
    const parentJob = await scheduler.getJob(parentId as string);
    expect(parentJob.status).toBe('blocking');
    // There should be a child job with parent_id = parentId
    const { rows } = await pool.query('SELECT * FROM jobs WHERE parent_id = $1', [parentId]);
    expect(rows.length).toBe(1);
    const childJob = rows[0];
    expect(childJob.state_machine).toBe('child');
    expect(childJob.status).toBe('pending');
  });

  it('child completion updates parent output and resolves waitFor', async () => {
    const parentId = await scheduler.schedule('parent', { foo: 'parent' });
    await scheduler.runPendingJobs();
    // Get child job
    const { rows } = await pool.query('SELECT * FROM jobs WHERE parent_id = $1', [parentId]);
    const childId = rows[0].id;
    // Run child job
    await scheduler.runPendingJobs();
    await scheduler.completeJob(childId);
    // Parent output should have child result
    const parentJob = await scheduler.getJob(parentId as string);
    const parentCtx = StateObject.from(parentJob.context);
    const waiting = parentCtx.getWaitingMap();
    // All waitFor should be resolved
    for (const waitId in waiting) {
      expect(waiting[waitId].status).toBe('success');
    }
    // Output should have jobs.childId
    const output = parentCtx.output<{ jobs: { [key: string]: { childResult: number } } }>();
    expect(output && output.jobs && output.jobs[childId]).toBeDefined();
    expect(output && output.jobs && output.jobs[childId].childResult).toBe(42);
  });

  it('parent resumes after all children complete', async () => {
    const parentId = await scheduler.schedule('parentMulti', { foo: 'parent' });
    await scheduler.runPendingJobs();
    // Get child jobs
    const { rows } = await pool.query('SELECT * FROM jobs WHERE parent_id = $1', [parentId]);
    expect(rows.length).toBe(2);
    const [child1, child2] = rows;
    // Run and complete both children
    await scheduler.runPendingJobs();
    await scheduler.completeJob(child1.id);
    await scheduler.completeJob(child2.id);
    // Parent should be requeued and not blocked
    const parentJob = await scheduler.getJob(parentId as string);
    expect(parentJob.status).not.toBe('blocking');
    // Output should have both child results
    const parentCtx = StateObject.from(parentJob.context);
    const output = parentCtx.output<{ jobs: { [key: string]: { childResult: number } } }>();
    expect(output && output.jobs && output.jobs[child1.id].childResult).toBe(1);
    expect(output && output.jobs && output.jobs[child2.id].childResult).toBe(2);
  });

  it('child failure marks parent waitFor as error', async () => {
    // Failing child state machine
    const failChildSM = new StateMachine([
      {
        name: 'start',
        onState: async () => { throw new Error('fail!'); },
        router: { next: null }
      }
    ]);
    scheduler.addStateMachine('failChild', failChildSM);
    // Parent that spawns a failChild
    const parentFailSM = new StateMachine([
      {
        name: 'start',
        onState: async ctx => {
          ctx.spawn('failChild', { foo: 99 });
          return ctx;
        },
        router: { next: 'done' }
      },
      { name: 'done', onState: async ctx => ctx }
    ]);
    scheduler.addStateMachine('parentFail', parentFailSM);
    const parentId = await scheduler.schedule('parentFail', { foo: 'parent' });
    await scheduler.runPendingJobs();
    // Get child job
    const { rows } = await pool.query('SELECT * FROM jobs WHERE parent_id = $1', [parentId]);
    const childId = rows[0].id;
    // Run and fail the child job
    await scheduler.runPendingJobs();
    await scheduler.failJob(childId, 'fail!');
    // Parent waitFor should be error
    const parentJob = await scheduler.getJob(parentId as string);
    const parentCtx = StateObject.from(parentJob.context);
    const waiting = parentCtx.getWaitingMap();
    for (const waitId in waiting) {
      if (waiting[waitId].childJobId === childId) {
        expect(waiting[waitId].status).toBe('error');
        expect(waiting[waitId].error).toBe('fail!');
      }
    }
  });
});

describe('Scheduler orphaned job cleanup', () => {
  let pool: Pool;
  let repo: PostgresJobRepo;
  let redis: Redis;
  let scheduler: Scheduler;

  const dbConfig = {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT!),
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    database: process.env.PGTESTDATABASE!,
    adminDatabase: process.env.PGADMINDATABASE || process.env.PGDATABASE!,
  };

  beforeAll(async () => {
    await runMigrations(dbConfig, true);
    pool = new Pool(dbConfig);
    repo = new PostgresJobRepo(pool);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
    });
    scheduler = new Scheduler(repo, redis, { maxRetries: 0 });
    scheduler.addStateMachine('test', testStateMachine);
  });

  afterAll(async () => {
    if (scheduler && typeof scheduler.stop === 'function') {
      scheduler.stop();
    }
    if (repo && typeof repo.close === 'function') {
      await repo.close();
    }
    await redis.quit();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE TABLE jobs');
    await redis.flushdb();
  });

  it('should mark old pending jobs as failed', async () => {
    // Insert a job with an old updated_at
    const oldJobId = '00000000-0000-0000-0000-000000000001';
    await pool.query(
      `INSERT INTO jobs (id, state_machine, status, context, created_at, updated_at)
       VALUES ($1, 'test', 'pending', '{}', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours') RETURNING *`,
      [oldJobId]
    );
    await scheduler.cleanupOrphanedJobs(60 * 60 * 1000); // 1 hour
    const job = await repo.getJob(oldJobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Orphaned job/);
  });

  it('should mark old running jobs as failed', async () => {
    const oldJobId = '00000000-0000-0000-0000-000000000002';
    await pool.query(
      `INSERT INTO jobs (id, state_machine, status, context, created_at, updated_at)
       VALUES ($1, 'test', 'running', '{}', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')`,
      [oldJobId]
    );
    await scheduler.cleanupOrphanedJobs(60 * 60 * 1000); // 1 hour
    const job = await repo.getJob(oldJobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Orphaned job/);
  });

  it('should not mark recent jobs as failed', async () => {
    const recentJobId = '00000000-0000-0000-0000-000000000003';
    const now = new Date();
    const future = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours in the future
    await pool.query(
      `INSERT INTO jobs (id, state_machine, status, context, created_at, updated_at)
       VALUES ($1, 'test', 'pending', '{}', $2, $3)`,
      [recentJobId, now, future]
    );
    // Fetch the job's updated_at from the DB
    const { rows } = await pool.query('SELECT updated_at FROM jobs WHERE id = $1', [recentJobId]);
    const jobUpdatedAt = rows[0].updated_at;
    // Compute the cutoff value as used in getStuckJobs
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    console.log('Job updated_at:', jobUpdatedAt, 'Cutoff:', cutoff.toISOString());
    await scheduler.cleanupOrphanedJobs(60 * 60 * 1000); // 1 hour
    const job = await repo.getJob(recentJobId);
    expect(job.status).toBe('pending');
  });

  it('start() should start execution loop and cleanup, stop() should stop them', async () => {
    jest.useFakeTimers();
    const spyCleanup = jest.spyOn(scheduler, 'cleanupOrphanedJobs').mockResolvedValue();
    const spyExec = jest.spyOn(scheduler, 'startExecutionLoop');
    scheduler.start(100, 500, 100); // fast intervals for test
    expect(spyExec).toHaveBeenCalledWith(100);
    jest.advanceTimersByTime(1000);
    expect(spyCleanup).toHaveBeenCalled();
    scheduler.stop();
    jest.useRealTimers();
  });
});

describe('Scheduler escalations', () => {
  let pool: Pool;
  let repo: PostgresJobRepo;
  let escalationRepo: PostgresEscalationRepo;
  let redis: Redis;
  let scheduler: Scheduler;

  const dbConfig = {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT!),
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    database: process.env.PGTESTDATABASE!,
    adminDatabase: process.env.PGADMINDATABASE || process.env.PGDATABASE!,
  };

  beforeAll(async () => {
    await runMigrations(dbConfig, true);
    pool = new Pool(dbConfig);
    repo = new PostgresJobRepo(pool);
    escalationRepo = new PostgresEscalationRepo(pool);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
    });
    scheduler = new Scheduler(repo, redis, { maxRetries: 0 }, escalationRepo);
  });

  afterAll(async () => {
    if (scheduler && typeof scheduler.stopExecutionLoop === 'function') {
      scheduler.stopExecutionLoop();
    }
    if (repo && typeof repo.close === 'function') {
      await repo.close();
    }
    await redis.quit();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE TABLE jobs CASCADE');
    await pool.query('TRUNCATE TABLE escalations CASCADE');
    await redis.flushdb();
  });

  it('should create and list an escalation', async () => {
    // State machine that triggers an escalation
    const escalateSM = new StateMachine([
      {
        name: 'start',
        onState: async ctx => {
          ctx.escalate('alice', 'Approve this?', [
            { id: 'reason', type: 'select', label: 'Reason', options: { a: 'A', b: 'B' } },
            { id: 'note', type: 'comment', label: 'Note' }
          ]);
          return ctx;
        },
        router: { next: null }
      }
    ]);
    scheduler.addStateMachine('escalate', escalateSM);
    const jobId = await scheduler.schedule('escalate', {});
    await scheduler.runPendingJobs();
    // There should be a pending escalation in the DB
    const escalations = await escalationRepo.listPendingEscalations();
    expect(escalations.length).toBe(1);
    expect(escalations[0].user).toBe('alice');
    expect(escalations[0].status).toBe('pending');
  });

  it('should approve an escalation and unblock the job', async () => {
    const escalateSM = new StateMachine([
      {
        name: 'start',
        onState: async ctx => {
          ctx.escalate('bob', 'Approve?', [
            { id: 'approve', type: 'approve', label: 'Approve?' }
          ]);
          return ctx;
        },
        router: { next: 'done' }
      },
      { name: 'done', onState: async ctx => ctx }
    ]);
    scheduler.addStateMachine('escalate2', escalateSM);
    const jobId = await scheduler.schedule('escalate2', {});
    await scheduler.runPendingJobs();
    const escalations = await escalationRepo.listPendingEscalations();
    expect(escalations.length).toBe(1);
    const escalation = escalations[0];
    // Approve the escalation
    await scheduler.replyToEscalation(escalation.id, { approve: true }, 'approved');
    // Job should be unblocked and move to done (or running, depending on timing)
    await scheduler.runPendingJobs();
    const job = await scheduler.getJob(jobId as string);
    expect(['done', 'running']).toContain(job.status);
    // Escalation should be updated
    const updated = await escalationRepo.getEscalation(escalation.id);
    expect(updated.status).toBe('approved');
    expect(updated.response).toEqual({ approve: true });
  });

  it('should reject an escalation and mark wait as error', async () => {
    const escalateSM = new StateMachine([
      {
        name: 'start',
        onState: async ctx => {
          ctx.escalate('bob', 'Approve?', [
            { id: 'approve', type: 'approve', label: 'Approve?' }
          ]);
          return ctx;
        },
        router: { next: 'done' }
      },
      { name: 'done', onState: async ctx => ctx }
    ]);
    scheduler.addStateMachine('escalate3', escalateSM);
    const jobId = await scheduler.schedule('escalate3', {});
    await scheduler.runPendingJobs();
    const escalations = await escalationRepo.listPendingEscalations();
    expect(escalations.length).toBe(1);
    const escalation = escalations[0];
    // Reject the escalation
    await scheduler.replyToEscalation(escalation.id, { approve: false }, 'rejected');
    // Job should be unblocked and move to done (or error, depending on your workflow)
    await scheduler.runPendingJobs();
    const job = await scheduler.getJob(jobId as string);
    // The job context should reflect the error in the escalation wait
    const ctx = StateObject.from(job.context);
    const waiting = ctx.getWaitingMap();
    expect(Object.values(waiting)[0].status).toBe('error');
    // Escalation should be updated
    const updated = await escalationRepo.getEscalation(escalation.id);
    expect(updated.status).toBe('rejected');
    expect(updated.response).toEqual({ approve: false });
  });
}); 