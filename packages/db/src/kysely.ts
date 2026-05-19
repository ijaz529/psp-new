import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/**
 * Hand-written Kysely Database interface. Mirrors the Drizzle schema; if you
 * add a column to Drizzle, mirror it here in the same PR. Kysely doesn't have
 * a Drizzle-generated typemap yet that we trust, so we keep these in sync by
 * hand for Phase 0. (Phase 3+ might revisit.)
 */
export interface Database {
  'paycore.merchants': {
    id: string;
    name: string;
    env: 'test' | 'live';
    allowed_origins: string[];
    reserve_basis_points: number;
    payout_schedule: 'daily' | 'weekly' | 'manual';
    kyb_status: 'pending' | 'submitted' | 'approved' | 'rejected';
    kyb_data: unknown | null;
    created_at: Date;
  };
  'paycore.portal_users': {
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    totp_secret: string | null;
    is_admin: boolean;
    created_at: Date;
    last_login_at: Date | null;
    disabled_at: Date | null;
  };
  'paycore.portal_sessions': {
    id: string;
    user_id: string;
    token_hash: string;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
  };
  'paycore.clearing_files': {
    id: string;
    scheme: 'visa' | 'mastercard' | 'amex';
    currency: string;
    file_date: Date;
    format: 'visa_base2' | 'mc_ipm';
    record_count: number;
    total_amount: bigint;
    path: string;
    created_at: Date;
  };
  'paycore.clearing_records': {
    id: string;
    clearing_file_id: string;
    payment_intent_id: string;
    merchant_id: string;
    scheme: string;
    currency: string;
    amount: bigint;
    rrn: string;
    occurred_at: Date;
    created_at: Date;
  };
  'paycore.payouts': {
    id: string;
    merchant_id: string;
    currency: string;
    amount: bigint;
    status: 'pending' | 'paid' | 'failed' | 'canceled';
    journal_entry_id: string;
    scheduled_for: Date;
    paid_at: Date | null;
    metadata: unknown | null;
    created_at: Date;
  };
  'paycore.api_keys': {
    id: string;
    merchant_id: string;
    kind: 'publishable' | 'secret';
    env: 'test' | 'live';
    prefix: string;
    sha256_hash: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  };
  'paycore.idempotency_keys': {
    merchant_id: string;
    key: string;
    method: string;
    path: string;
    request_hash: string;
    response_status: number | null;
    response_body: unknown | null;
    locked_at: Date | null;
    completed_at: Date | null;
    expires_at: Date;
    created_at: Date;
  };
  'paycore.customers': {
    id: string;
    merchant_id: string;
    email: string | null;
    name: string | null;
    description: string | null;
    metadata: unknown | null;
    created_at: Date;
  };
  'paycore.payment_methods': {
    id: string;
    merchant_id: string;
    customer_id: string | null;
    token_id: string;
    bin: string;
    last4: string;
    scheme: string;
    exp_month: string | null;
    exp_year: string | null;
    created_at: Date;
  };
  'paycore.payment_intents': {
    id: string;
    merchant_id: string;
    customer_id: string | null;
    payment_method_id: string | null;
    amount: bigint;
    amount_received: bigint;
    amount_capturable: bigint;
    currency: string;
    status: string;
    capture_method: string;
    confirmation_method: string;
    client_secret: string;
    last_payment_error_code: string | null;
    last_payment_error_message: string | null;
    last_payment_error_decline_code: string | null;
    metadata: unknown | null;
    livemode: boolean;
    next_action: unknown | null;
    request_three_d_secure: 'automatic' | 'any' | 'never';
    last_auth_rrn: string | null;
    last_auth_stan: string | null;
    created_at: Date;
    updated_at: Date;
  };
  'paycore.three_ds_sessions': {
    id: string;
    merchant_id: string;
    payment_intent_id: string;
    token_id: string;
    scheme: string;
    status: 'pending' | 'approved' | 'declined' | 'expired';
    eci: string | null;
    cavv: string | null;
    trans_status: string | null;
    redirect_url: string;
    expires_at: Date;
    completed_at: Date | null;
    created_at: Date;
  };
  'paycore.refunds': {
    id: string;
    merchant_id: string;
    payment_intent_id: string;
    amount: bigint;
    currency: string;
    status: string;
    reason: string | null;
    journal_entry_id: string;
    metadata: unknown | null;
    created_at: Date;
  };
  'paycore.events': {
    id: string;
    merchant_id: string;
    type: string;
    api_version: string;
    resource_id: string | null;
    data: unknown;
    livemode: boolean;
    created_at: Date;
  };
  'paycore.webhook_endpoints': {
    id: string;
    merchant_id: string;
    url: string;
    description: string | null;
    enabled_events: string[];
    signing_secret: string;
    status: string;
    created_at: Date;
    disabled_at: Date | null;
  };
  'paycore.webhook_attempts': {
    id: string;
    event_id: string;
    endpoint_id: string;
    attempt_number: number;
    http_status: number | null;
    response_body: string | null;
    error: string | null;
    delivered_at: Date | null;
    next_retry_at: Date | null;
    created_at: Date;
  };
  'paycore.webhook_dead_letter': {
    id: string;
    event_id: string;
    endpoint_id: string;
    reason: string;
    last_error: string | null;
    failed_after_attempts: number;
    created_at: Date;
    retried_at: Date | null;
  };
  'paycore.risk_decisions': {
    id: string;
    merchant_id: string;
    payment_intent_id: string;
    outcome: 'allow' | 'review' | 'deny';
    score: number;
    triggered_rules: string[];
    evidence: unknown | null;
    created_at: Date;
  };
  'paycore.disputes': {
    id: string;
    merchant_id: string;
    payment_intent_id: string;
    scheme: string;
    reason_code: string;
    state:
      | 'retrieval_request'
      | 'first_chargeback'
      | 'representment'
      | 'pre_arbitration'
      | 'arbitration'
      | 'won'
      | 'lost'
      | 'expired';
    amount: bigint;
    currency: string;
    evidence_due_at: Date | null;
    evidence: unknown | null;
    created_at: Date;
    updated_at: Date;
  };
  'paycore.dispute_events': {
    id: string;
    dispute_id: string;
    event_type: string;
    data: unknown | null;
    created_at: Date;
  };
  'paycore.outbox': {
    id: string;
    event_type: string;
    payload: unknown;
    headers: unknown | null;
    resource_id: string | null;
    created_at: Date;
    locked_at: Date | null;
    delivered_at: Date | null;
    attempts: number;
    last_error: string | null;
  };
  'paycore._schema_migrations': {
    filename: string;
    applied_at: Date;
    checksum_sha256: string;
  };
  'ledger.currencies': {
    code: string;
    numeric: string;
    minor_units: number;
    name: string;
  };
  'ledger.accounts': {
    id: string;
    code: string;
    type: string;
    currency: string;
    owner_kind: string;
    owner_id: string | null;
    metadata: string | null;
    created_at: Date;
  };
  'ledger.journal_entries': {
    id: string;
    external_id: string;
    description: string;
    occurred_at: Date;
    created_at: Date;
  };
  'ledger.journal_lines': {
    id: string;
    entry_id: string;
    account_id: string;
    amount: bigint;
    currency: string;
    created_at: Date;
  };
  /**
   * Materialized view; refreshed by a periodic job (Phase 6+). Reads are stale
   * by up to the refresh interval; for hot-path "what's my current balance"
   * callers should fall back to `SUM(amount) FROM journal_lines`.
   */
  'ledger.account_balances': {
    account_id: string;
    currency: string;
    debit_total: bigint;
    credit_total: bigint;
    balance: bigint;
    last_journal_at: Date | null;
  };
  'vault.tokens': {
    id: string;
    merchant_id: string;
    pan_hmac: string;
    bin: string;
    last4: string;
    exp_month: string | null;
    exp_year: string | null;
    scheme: string;
    /** Full KMS blob value (`keyId.b64nonce.b64ct.b64tag`). Phase 2. */
    pan_ciphertext: string | null;
    /** Key id used for encryption; redundant with the blob value but useful for rotation queries. */
    kms_key_id: string | null;
    created_at: Date;
    last_used_at: Date | null;
  };
  'vault.detokenize_audit': {
    id: string;
    token_id: string;
    merchant_id: string;
    sender: string;
    reason: string;
    request_id: string | null;
    detokenized_at: Date;
  };
  /* --- Phase 9: issuing ----------------------------------------------- */
  'paycore.card_products': {
    id: string;
    name: string;
    scheme: 'visa' | 'mastercard';
    bin_range_low: string;
    bin_range_high: string;
    currency: string;
    default_controls: unknown;
    created_at: Date;
  };
  'paycore.cardholders': {
    id: string;
    email: string;
    full_name: string;
    phone: string | null;
    status: 'active' | 'suspended';
    created_at: Date;
  };
  'paycore.cards': {
    id: string;
    product_id: string;
    cardholder_id: string;
    pan_token: string;
    bin: string;
    last4: string;
    exp_month: string;
    exp_year: string;
    status: 'active' | 'frozen' | 'cancelled';
    controls: unknown;
    funded_account_id: string;
    holds_account_id: string;
    created_at: Date;
  };
  'paycore.card_auth_holds': {
    id: string;
    card_id: string;
    stan: string;
    rrn: string;
    amount: bigint;
    currency: string;
    merchant_name: string | null;
    mcc: string | null;
    approval_code: string | null;
    created_at: Date;
    resolved_at: Date | null;
    resolved_reason: 'captured' | 'reversed' | 'expired' | null;
  };
  'paycore.card_loads': {
    id: string;
    card_id: string;
    payment_method_id: string;
    amount: bigint;
    currency: string;
    status: 'succeeded' | 'failed';
    response_code: string;
    rrn: string | null;
    stan: string | null;
    failure_code: string | null;
    failure_message: string | null;
    journal_entry_id: string | null;
    created_at: Date;
  };
}

export function createKysely(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Map int8/bigint columns to native BigInt instead of string. Call once at boot. */
export function configurePgTypes(): void {
  // 20 = int8 (bigint) OID
  pg.types.setTypeParser(20, (v) => BigInt(v));
}
