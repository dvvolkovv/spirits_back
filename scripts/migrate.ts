#!/usr/bin/env ts-node
/**
 * Simple SQL migration runner for spirits_back.
 *
 * Scans src/<module>/migrations/*.sql in lexicographic order.
 * Tracks applied migrations in `schema_migrations` table.
 * Each file runs in a transaction.
 *
 * Usage:
 *   npm run migrate           # apply all pending
 *   npm run migrate -- --dry  # show pending without applying
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const dryRun = process.argv.includes('--dry');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function discoverMigrations(): Array<{ filename: string; fullPath: string }> {
  const srcDir = path.join(__dirname, '..', 'src');
  const found: Array<{ filename: string; fullPath: string }> = [];
  for (const moduleDir of fs.readdirSync(srcDir)) {
    const migDir = path.join(srcDir, moduleDir, 'migrations');
    if (!fs.existsSync(migDir)) continue;
    for (const file of fs.readdirSync(migDir)) {
      if (file.endsWith('.sql')) {
        found.push({
          filename: `${moduleDir}/${file}`,
          fullPath: path.join(migDir, file),
        });
      }
    }
  }
  found.sort((a, b) => a.filename.localeCompare(b.filename));
  return found;
}

async function appliedSet(): Promise<Set<string>> {
  const res = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(res.rows.map((r) => r.filename));
}

async function applyMigration(filename: string, fullPath: string): Promise<void> {
  const sql = fs.readFileSync(fullPath, 'utf-8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    console.log(`✓ applied ${filename}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection likely dead */ }
    const pgErr = err as { code?: string; position?: string; detail?: string; hint?: string; message: string };
    console.error(`PG error in ${filename}: code=${pgErr.code ?? 'n/a'} position=${pgErr.position ?? 'n/a'} detail=${pgErr.detail ?? 'n/a'} hint=${pgErr.hint ?? 'n/a'}`);
    const wrappedErr = new Error(`Failed to apply ${filename}: ${pgErr.message}`);
    (wrappedErr as any).cause = err;
    throw wrappedErr;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  // Serialize concurrent migrate runs (Flyway-style advisory lock).
  // 8675309 is an arbitrary constant; must match across all runs.
  await pool.query('SELECT pg_advisory_lock(8675309)');
  try {
    await ensureMigrationsTable();
    const all = discoverMigrations();
    const applied = await appliedSet();
    const pending = all.filter((m) => !applied.has(m.filename));

    if (pending.length === 0) {
      console.log('No pending migrations');
      return;
    }

    console.log(`Pending migrations (${pending.length}):`);
    for (const m of pending) console.log(`  - ${m.filename}`);

    if (dryRun) {
      console.log('(dry run, not applying)');
      return;
    }

    for (const m of pending) {
      await applyMigration(m.filename, m.fullPath);
    }
    console.log(`Applied ${pending.length} migration(s)`);
  } finally {
    await pool.query('SELECT pg_advisory_unlock(8675309)');
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
