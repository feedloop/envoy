const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

/**
 * Ensures the target database exists by connecting to an admin database (default: 'postgres').
 * @param {Object} config - The connection config, with optional adminDatabase property.
 */
async function ensureDatabaseExists(config) {
  // Use adminDatabase if provided, else default to 'postgres'
  const adminDb = config.adminDatabase || 'postgres';
  const adminConfig = { ...config, database: adminDb };
  const client = new Client(adminConfig);
  await client.connect();
  // Check if the target database exists
  const dbName = config.database;
  const res = await client.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [dbName]
  );
  if (res.rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Created database: ${dbName}`);
  }
  await client.end();
}

/**
 * Runs migrations on the target database, ensuring it exists first.
 * @param {Object} config - The connection config, with optional adminDatabase property.
 */
async function runMigrations(config) {
  await ensureDatabaseExists(config);
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
    const applied = new Set(res.rows.map(row => row.filename));
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
if (require.main === module) {
  require('dotenv').config();
  runMigrations({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    adminDatabase: process.env.PGADMINDATABASE || 'postgres',
  }).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { runMigrations }; 