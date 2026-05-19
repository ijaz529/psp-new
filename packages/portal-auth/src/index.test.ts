import { describe, expect, it } from 'vitest';
import {
  buildClearCardholderCookie,
  buildClearCookie,
  buildSetCardholderCookie,
  buildSetCookie,
  hashPassword,
  readCardholderSessionCookie,
  readSessionCookie,
  verifyPassword,
} from './index.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a strong password', () => {
    const h = hashPassword('correct-horse-battery-staple');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct-horse-battery-staple', h)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const h = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('wrong-password', h)).toBe(false);
  });

  it('rejects short passwords at hash time', () => {
    expect(() => hashPassword('short')).toThrow();
  });

  it('returns false on malformed stored hash', () => {
    expect(verifyPassword('any', 'not-a-real-hash')).toBe(false);
    expect(verifyPassword('any', 'argon2$x$y')).toBe(false);
  });

  it('two hashes of the same password are different (different salt)', () => {
    const a = hashPassword('correct-horse-battery-staple');
    const b = hashPassword('correct-horse-battery-staple');
    expect(a).not.toBe(b);
    expect(verifyPassword('correct-horse-battery-staple', a)).toBe(true);
    expect(verifyPassword('correct-horse-battery-staple', b)).toBe(true);
  });
});

describe('cookie helpers', () => {
  it('buildSetCookie returns HttpOnly + SameSite=Lax', () => {
    const c = buildSetCookie('abc.def');
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Max-Age=604800/);
    expect(c).toMatch(/strawberry_portal_session=abc\.def/);
  });

  it('buildClearCookie zeroes Max-Age', () => {
    expect(buildClearCookie()).toMatch(/Max-Age=0/);
  });

  it('readSessionCookie parses the cookie header', () => {
    expect(readSessionCookie('foo=bar; strawberry_portal_session=xxx; baz=qux')).toBe('xxx');
    expect(readSessionCookie('foo=bar')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });
});

describe('Phase 22 — cardholder cookie helpers', () => {
  it('buildSetCardholderCookie uses the cardholder-scoped name + 30-day Max-Age', () => {
    const c = buildSetCardholderCookie('cardholder-token');
    expect(c).toMatch(/strawberry_cardholder_session=cardholder-token/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Max-Age=2592000/); // 30 days in seconds
  });

  it('buildClearCardholderCookie zeroes Max-Age and uses the cardholder name', () => {
    const c = buildClearCardholderCookie();
    expect(c).toMatch(/strawberry_cardholder_session=/);
    expect(c).toMatch(/Max-Age=0/);
  });

  it('readCardholderSessionCookie parses ONLY the cardholder cookie, ignoring the admin one', () => {
    expect(
      readCardholderSessionCookie(
        'foo=bar; strawberry_portal_session=admin; strawberry_cardholder_session=ch1; baz=qux',
      ),
    ).toBe('ch1');
    expect(readCardholderSessionCookie('strawberry_portal_session=admin')).toBeNull();
    expect(readCardholderSessionCookie(undefined)).toBeNull();
  });

  it('admin and cardholder cookie names are distinct', () => {
    expect(buildSetCookie('x')).not.toContain('strawberry_cardholder_session');
    expect(buildSetCardholderCookie('x')).not.toContain('strawberry_portal_session=');
  });
});
