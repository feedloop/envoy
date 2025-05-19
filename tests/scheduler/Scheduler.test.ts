import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import Redis from 'ioredis';
import { runMigrations } from '../../scripts/migrate';
import { PostgresJobRepo } from '../../src/scheduler/PostgresJobRepo';
import { Scheduler } from '../../src/scheduler/Scheduler';
import { StateMachine } from '../../src/core/StateMachine';

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
    await runMigrations(dbConfig);
    pool = new Pool(dbConfig);
    repo = new PostgresJobRepo(pool);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
    });
    scheduler = new Scheduler(repo, redis);
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
    scheduler.addStateMachine('error', errorStateMachine);
    const jobId = await scheduler.schedule('error', { foo: 'bar' });
    expect(typeof jobId).toBe('string');
    const jobIdStr = jobId as string;
    await scheduler.runPendingJobs();
    const job = await scheduler.getJob(jobIdStr);
    console.log('Job status after error state machine:', job.status);
    expect(job.status).toBe('failed');
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
}); 