import { monotonicFactory } from 'ulid';

/**
 * Monotonic ULID: within the same millisecond, subsequent IDs are guaranteed to
 * be lexicographically greater than previous ones. This is required for
 * per-resource event ordering (outbox + webhook delivery).
 */
const ulid = monotonicFactory();

/**
 * Resource prefixes — Stripe convention. Sortable opaque IDs, no information leak.
 * Add new prefixes here so the type is exhaustive across the codebase.
 */
export const RESOURCE_PREFIXES = {
  payment_intent: 'pi',
  payment_method: 'pm',
  charge: 'ch',
  refund: 're',
  dispute: 'dp',
  payout: 'po',
  event: 'evt',
  webhook_endpoint: 'we',
  webhook_attempt: 'wa',
  webhook_dead_letter: 'wdl',
  merchant: 'mrch',
  api_key: 'ak',
  customer: 'cus',
  idempotency_record: 'idem',
  outbox_event: 'oe',
  journal_entry: 'je',
  journal_line: 'jl',
  account: 'acct',
  token: 'tok',
  detokenize_audit: 'da',
  risk_decision: 'rd',
  three_ds_session: 'tds',
  request: 'req',
  card_product: 'prod',
  cardholder: 'ch',
  card: 'card',
  card_auth_hold: 'hold',
  card_load: 'cl',
} as const;

export type ResourceKind = keyof typeof RESOURCE_PREFIXES;
export type ResourcePrefix = (typeof RESOURCE_PREFIXES)[ResourceKind];

export type ResourceId<K extends ResourceKind = ResourceKind> = `${(typeof RESOURCE_PREFIXES)[K]}_${string}`;

export function newId<K extends ResourceKind>(kind: K): ResourceId<K> {
  return `${RESOURCE_PREFIXES[kind]}_${ulid()}` as ResourceId<K>;
}

export function isResourceId<K extends ResourceKind>(value: unknown, kind: K): value is ResourceId<K> {
  if (typeof value !== 'string') return false;
  const prefix = RESOURCE_PREFIXES[kind];
  if (!value.startsWith(`${prefix}_`)) return false;
  const ulidPart = value.slice(prefix.length + 1);
  return isUlid(ulidPart);
}

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}

/** Parse an ID and return the kind + ULID, or null if malformed. */
export function parseResourceId(value: string): { kind: ResourceKind; ulid: string } | null {
  const underscoreIdx = value.indexOf('_');
  if (underscoreIdx === -1) return null;
  const prefix = value.slice(0, underscoreIdx);
  const ulidPart = value.slice(underscoreIdx + 1);
  if (!isUlid(ulidPart)) return null;
  for (const [kind, p] of Object.entries(RESOURCE_PREFIXES)) {
    if (p === prefix) return { kind: kind as ResourceKind, ulid: ulidPart };
  }
  return null;
}
