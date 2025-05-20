import Redis from "ioredis";
import { SchedulerConfig } from "./types";
import { SchedulerService } from "./SchedulerService";
import { PostgresJobRepo } from "./PostgresJobRepo";
import { Pool } from "pg";

export * from "./types";
export * from "./SchedulerService";
export * from "./PostgresJobRepo";

export function initScheduler(config: SchedulerConfig) {
    const redis = new Redis({
      host: config.redis?.host ?? 'localhost',
      port: config.redis?.port ?? 6379,
      password: config.redis?.password ?? undefined,
    });

    let pool = new Pool({
      host: config.postgres?.host ?? 'localhost',
      port: config.postgres?.port ?? 5432,
      password: config.postgres?.password ?? 'postgres',
      database: config.postgres?.database ?? 'postgres',
    });

    let jobRepo = new PostgresJobRepo(pool);

    return new SchedulerService(jobRepo, redis, {
      concurrency: config.concurrency ?? 1,
      maxRetries: config.maxRetries ?? 3,
    });
}
