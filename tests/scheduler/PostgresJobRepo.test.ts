import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { runMigrations } from '../../scripts/migrate';
import { PostgresJobRepo } from '../../src/scheduler/PostgresJobRepo';
import { JobSchema, JobStatus } from '../../src/scheduler/types';

describe('PostgresJobRepo', () => {
  let pool: Pool;
  let repo: PostgresJobRepo;

  const dbConfig = {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT!),
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    database: process.env.PGTESTDATABASE!,
    adminDatabase: process.env.PGDATABASE!,
  };

  beforeAll(async () => {
    await runMigrations(dbConfig, true);
    pool = new Pool(dbConfig);
    repo = new PostgresJobRepo(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE TABLE jobs');
  });

  const baseJob: JobSchema = {
    id: 'test_job',
    stateMachine: 'test_machine',
    status: 'pending' as JobStatus,
    context: {
      state: 'start',
      step: 0,
      input: {},
      output: {},
      waiting: {},
      data: {},
      done: null,
      execState: 'enter',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    error: null,
    parent_id: null,
    retries: 0,
  };

  it('should create and get a job', async () => {
    const job = await repo.createJob(baseJob);
    const fetched = await repo.getJob(job.id);
    expect(fetched).toMatchObject({
      stateMachine: baseJob.stateMachine,
      status: baseJob.status,
      context: baseJob.context,
    });
  });

  it('should update a job', async () => {
    const job = await repo.createJob(baseJob);
    const updated = await repo.updateJob(job.id, { status: 'running' });
    expect(updated.status).toBe('running');
    expect(updated.id).toBe(job.id);
  });

  it('should get pending jobs', async () => {
    await repo.createJob(baseJob);
    await repo.createJob({ ...baseJob, stateMachine: 'other' });
    const pending = await repo.getPendingJobs(10);
    expect(pending.length).toBe(2);
    expect(pending[0].status).toBe('pending');
  });

  it('should set job status and error', async () => {
    const job = await repo.createJob(baseJob);
    const done = await repo.setJobStatus(job.id, 'done', 'no error');
    expect(done.status).toBe('done');
    expect(done.error).toBe('no error');
    expect(done.finishedAt).not.toBeNull();
  });

  it('should throw when getting a non-existent job', async () => {
    await expect(repo.getJob('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
}); 