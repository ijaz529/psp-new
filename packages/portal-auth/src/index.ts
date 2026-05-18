import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import type { Kysely } from 'kysely';

/**
 * Password hashing: scrypt N=2^15, r=8, p=1, 64-byte output.
 * Format: `scrypt$<salt-b64>$<hash-b64>`. Migration to argon2id when we have a
 * native build pipeline; scrypt ships in Node core which keeps the dev story simple.
 */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN = 64;
// Node's default scrypt maxmem is 32 MiB which is below what N=2^15 needs.
// Bump it explicitly. ~128 MiB is comfortable for Phase 8.
const MAX_MEM = 128 * 1024 * 1024;

export function hashPassword(password: string): string {
  if (password.length < 8) throw new PspError('parameter_invalid', { message: 'password must be at least 8 chars' });
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltStr = parts[1];
  const hashStr = parts[2];
  if (!saltStr || !hashStr) return false;
  const salt = Buffer.from(saltStr, 'base64');
  const hash = Buffer.from(hashStr, 'base64');
  if (hash.length !== HASH_LEN) return false;
  const test = scryptSync(password, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM });
  return timingSafeEqual(test, hash);
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export const SESSION_COOKIE = 'wirecore_portal_session';
const SESSION_TTL_MS = 7 * 86_400_000; // 7 days

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly token: string; // raw — only available at creation time
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string } = {},
): Promise<SessionRecord> {
  const id = newId('outbox_event').replace('oe_', 'ps_'); // reuse ULID space
  const tokenRaw = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');
  const now = new Date();
  await db
    .insertInto('paycore.portal_sessions')
    .values({
      id,
      user_id: userId,
      token_hash: tokenHash,
      ip_address: meta.ipAddress ?? null,
      user_agent: meta.userAgent ?? null,
      created_at: now,
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
      revoked_at: null,
    })
    .execute();
  return { id, userId, token: tokenRaw };
}

export async function resolveSession(
  db: Kysely<Database>,
  cookieValue: string,
): Promise<{ user: Database['paycore.portal_users']; sessionId: string } | null> {
  const tokenHash = createHash('sha256').update(cookieValue).digest('hex');
  const row = await db
    .selectFrom('paycore.portal_sessions')
    .innerJoin('paycore.portal_users', 'paycore.portal_users.id', 'paycore.portal_sessions.user_id')
    .selectAll('paycore.portal_users')
    .select([
      'paycore.portal_sessions.id as session_id',
      'paycore.portal_sessions.expires_at as expires_at',
      'paycore.portal_sessions.revoked_at as revoked_at',
    ])
    .where('paycore.portal_sessions.token_hash', '=', tokenHash)
    .executeTakeFirst();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at.getTime() < Date.now()) return null;
  if (row.disabled_at) return null;
  return {
    user: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      password_hash: row.password_hash,
      totp_secret: row.totp_secret,
      is_admin: row.is_admin,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
      disabled_at: row.disabled_at,
    },
    sessionId: row.session_id as string,
  };
}

export async function revokeSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db.updateTable('paycore.portal_sessions').set({ revoked_at: new Date() }).where('id', '=', sessionId).execute();
}

/* -------------------------------------------------------------------------- */
/* Cookie helpers                                                              */
/* -------------------------------------------------------------------------- */

export function buildSetCookie(token: string): string {
  // 7-day Max-Age, HttpOnly, SameSite=Lax. Secure: prod only — Phase 8 dev runs over HTTP.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === SESSION_COOKIE) return part.slice(eq + 1);
  }
  return null;
}
