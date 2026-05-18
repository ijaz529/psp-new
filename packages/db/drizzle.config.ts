import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://psp:psp_dev_password@localhost:5432/psp_new',
  },
  // We hand-write migrations for things Drizzle Kit doesn't produce well
  // (CREATE SCHEMA, EXTENSION, seed INSERTs, constraint triggers in Phase 1).
  // `drizzle-kit generate` is wired but not the source of truth.
  strict: true,
  verbose: true,
} satisfies Config;
