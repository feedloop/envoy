import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import dotenv from 'dotenv';

export interface MigrationConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  adminDatabase?: string;
}

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

/**
 * Ensures the target database exists by connecting to an admin database (default: 'postgres').
 */
export async function ensureDatabaseExists(config: MigrationConfig, alwaysClean = false): Promise<void> {
  const adminDb = config.adminDatabase || 'postgres';
  const adminConfig = { ...config, database: adminDb };
  const client = new Client(adminConfig);
  await client.connect();
  const dbName = config.database;
  if (alwaysClean) {
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName]);
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Dropped and created database: ${dbName}`);
  } else {
    const res = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    if (res.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    }
  }
  await client.end();
}

/**
 * Runs migrations on the target database, ensuring it exists first.
 */
export async function runMigrations(config: MigrationConfig, alwaysClean = false): Promise<void> {
  await ensureDatabaseExists(config, alwaysClean);
  const client = new Client(config);
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const res = await client.query('SELECT filename FROM migrations ORDER BY filename');
    const applied = new Set(res.rows.map((row: any) => row.filename));
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.match(/^\d+_.+\.sql$/))
      .sort();
    for (const file of files) {
      if (!applied.has(file)) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
          await client.query('COMMIT');
          console.log(`Applied migration: ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    }
    console.log('All migrations applied.');
  } finally {
    await client.end();
  }
}

// CLI entrypoint
// @ts-ignore
if (require.main === module) {
  dotenv.config();
  const alwaysClean = process.argv.includes('--clean');
  console.log('Running migrations on database:', process.env.PGDATABASE!);
  runMigrations({
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT!),
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    database: process.env.PGDATABASE!,
    adminDatabase: process.env.PGADMINDATABASE || 'postgres',
  }, alwaysClean).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
} 