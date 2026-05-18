import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrationFiles } from './migrate.js';

describe('loadMigrationFiles', () => {
  it('returns files in lexicographic order with sha256 checksums', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'psp-mig-'));
    try {
      await writeFile(join(dir, '0002_b.sql'), 'select 2;');
      await writeFile(join(dir, '0001_a.sql'), 'select 1;');
      await writeFile(join(dir, 'README.md'), 'not a migration');
      const files = await loadMigrationFiles(dir);
      expect(files.map((f) => f.filename)).toEqual(['0001_a.sql', '0002_b.sql']);
      expect(files[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(files[0]!.checksum).not.toBe(files[1]!.checksum);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a directory with no .sql files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'psp-mig-'));
    try {
      await writeFile(join(dir, 'notes.txt'), 'hi');
      const files = await loadMigrationFiles(dir);
      expect(files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles 4-digit prefix sort correctly across boundaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'psp-mig-'));
    try {
      for (const i of [10, 1, 9, 2]) {
        await writeFile(join(dir, `${String(i).padStart(4, '0')}_x.sql`), `-- ${i}`);
      }
      const files = await loadMigrationFiles(dir);
      expect(files.map((f) => f.filename)).toEqual(['0001_x.sql', '0002_x.sql', '0009_x.sql', '0010_x.sql']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
