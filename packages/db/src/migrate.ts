import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/**
 * Forward-only SQL migration runner. Filenames must sort lexicographically
 * (we use 4-digit prefixes: 0001, 0002, ...). Each migration runs in its own
 * transaction, guarded by a session-level advisory lock so two boots can't
 * concurrently apply the same set.
 *
 * Tracking table: paycore._schema_migrations (filename PK + checksum).
 *
 * Idempotency: applying the same set twice is a no-op. If a previously-applied
 * file changes (checksum mismatch), the migrator refuses and the operator must
 * write a new forward migration to correct.
 */

const ADVISORY_LOCK_KEY = 0xa10c_03 as const; // arbitrary 32-bit constant for `pg_advisory_lock(int)`

export interface MigrationFile {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sqlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
  const out: MigrationFile[] = [];
  for (const filename of sqlFiles) {
    const sql = await readFile(join(dir, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    out.push({ filename, sql, checksum });
  }
  return out;
}

export interface MigrateResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function migrateUp(pool: pg.Pool, migrationsDir: string): Promise<MigrateResult> {
  const files = await loadMigrationFiles(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];

  const client = await pool.connect();
  try {
    await client.query(`select pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);
    try {
      // Bootstrap the tracking table if the schema doesn't exist yet — the first
      // migration creates `paycore`, so we run that first without a check.
      await ensureTrackingTable(client);
      const { rows } = await client.query<{ filename: string; checksum_sha256: string }>(
        `select filename, checksum_sha256 from paycore._schema_migrations`,
      );
      const already = new Map(rows.map((r) => [r.filename, r.checksum_sha256]));

      for (const f of files) {
        const prev = already.get(f.filename);
        if (prev) {
          if (prev !== f.checksum) {
            throw new Error(
              `Migration ${f.filename} has been modified after being applied (checksum mismatch). ` +
                `Write a new forward migration to correct.`,
            );
          }
          skipped.push(f.filename);
          continue;
        }
        await client.query('begin');
        try {
          await client.query(f.sql);
          await client.query(`insert into paycore._schema_migrations (filename, checksum_sha256) values ($1, $2)`, [
            f.filename,
            f.checksum,
          ]);
          await client.query('commit');
          applied.push(f.filename);
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      }
    } finally {
      await client.query(`select pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}

async function ensureTrackingTable(client: pg.PoolClient): Promise<void> {
  // The first migration creates `paycore` schema. Until then, the tracking table
  // can't live there. We solve this by always running 0001_init_schemas.sql first
  // (it creates the schema AND the tracking table inside it), so this helper
  // only needs to no-op when the table already exists.
  await client.query(`
    do $$
    begin
      if not exists (
        select 1
        from information_schema.schemata
        where schema_name = 'paycore'
      ) then
        return;
      end if;
      if not exists (
        select 1
        from information_schema.tables
        where table_schema = 'paycore' and table_name = '_schema_migrations'
      ) then
        execute $sql$
          create table paycore._schema_migrations (
            filename text primary key,
            applied_at timestamptz not null default now(),
            checksum_sha256 text not null
          )
        $sql$;
      end if;
    end
    $$;
  `);
}
