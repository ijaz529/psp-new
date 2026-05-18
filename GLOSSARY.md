# Glossary

Payment-domain terms get muddled. Define them here as they enter the codebase.
Sorted alphabetically. Cross-link related terms with bracketed back-refs.

---

**3DS Server / Directory Server / ACS** — The three actors in EMV 3DS.
The 3DS Server (us, in Phase 4) talks to the Directory Server (the scheme's
router; simulated by us). The DS routes to the Access Control Server (run by the
issuer; also simulated). The 3DS Server sends *AReq* (authentication request)
and may receive *ARes* (authentication response) or *CReq*/*CRes* (challenge
exchange) depending on whether the issuer requires a challenge.

**ACS** — Access Control Server. See *3DS Server*.

**API key — publishable vs secret** — *Publishable* keys (`pk_*`) are safe to
embed in browser bundles; they can only tokenize at the hosted-fields endpoint.
*Secret* keys (`sk_*`) authorize all server-side calls. Both are scoped to a
*MID* and an env (test/live).

**Authorization (auth)** — A scheme-level message asking the issuer to put a
hold on the cardholder's available balance. Authorizes but does not move money;
that happens at *Settlement*. See *Auth-hold*.

**Auth-hold** — The actual reservation on the issuer's books resulting from a
successful auth. Released on void, decremented on capture, or expires (usually
7–30 days). Distinct from *Authorization*, which is the message.

**AVS** — Address Verification Service. Issuer-side check that the billing
address (numeric portions) matches what they have on file. Returns a one-letter
code (`Y`, `N`, `A`, `Z`, `U`, etc.).

**BIN** — Bank Identification Number. The first 6 (or sometimes 8) digits of a
PAN; identifies the issuer and the *scheme*. Public information.

**CAVV** — Cardholder Authentication Verification Value. Cryptographic proof
issued by the ACS that the cardholder authenticated through 3DS. Carried into
authorization in DE 48.43.

**Capture** — A scheme-level message instructing the system to convert an
*Auth-hold* into a *Clearing* record so funds actually move at *Settlement*.
Full capture, partial capture, multi-capture all valid. See also: *void*,
*reversal*, *refund*.

**Chargeback** — A *Dispute* outcome where the issuer reverses the merchant's
*Settlement* leg and re-credits the cardholder. Triggered by a cardholder
complaint or fraud signal; carries a *Reason Code*.

**Clearing** — The end-of-day file/message exchange between acquirer and scheme
that *registers* the transaction for actual money movement. Distinct from
*Settlement*, which is the money movement itself. Visa: *Base II*. Mastercard:
*IPM* (Integrated Product Messages).

**CVV / CVC / CVV2** — Card Verification Value (Visa) / Card Validation Code
(Mastercard) / Card Verification Value 2. The 3-digit (or 4-digit, Amex) number
on the back of the card. **Never logged, ever** — *PCI cat-1 sensitive*.

**Decline code** — A sub-axis of `card_declined`. Maps loosely to an *ISO 8583
Response Code* (DE 39); we expose Stripe-compatible values
(`insufficient_funds`, `do_not_honor`, `lost_card`, etc.) so merchants can react.

**Dispute** — Umbrella for retrieval requests, *Chargebacks*, representments,
pre-arbitration, and arbitration. State machine over the dispute lifecycle.

**ECI** — Electronic Commerce Indicator. A 2-digit value carried in *DE 60*
indicating the 3DS outcome:
- `05`/`02` — fully authenticated
- `06`/`01` — attempted (issuer did not authenticate)
- `07`/`00` — no 3DS attempted

The first value in each pair is the Visa code; the second is Mastercard.

**Fils** — Minor unit for AED, BHD, JOD, KWD (1/100 or 1/1000). Generic project
shorthand for "always store as integer minor units." Never floats.

**Idempotency-Key** — HTTP header on state-changing requests. Identical body +
identical key returns the cached response; mismatched body returns 422; in-flight
returns 409. See *ADR-0006*.

**Interchange** — Fee the issuer charges the acquirer per transaction. Set by
the scheme. The PSP's expense account at *Settlement*.

**ISO 8583** — The card-network message format. We implement the 1987 dialect
with ASCII LLVAR/LLLVAR length prefixes per *PROJECT_BRIEF.md §3 Phase 5*.

**IPM** — Integrated Product Messages. Mastercard's clearing file format. We
emit an IPM-like CSV from the scheme-simulator.

**KMS** — Key Management Service. Holds master keys; provides encrypt/decrypt
and HMAC primitives. We use a local-file provider in dev (see *ADR-0004*).

**MCC** — Merchant Category Code. 4-digit ISO 18245 code categorizing the
merchant's line of business. Drives interchange tiering, AVS rules, and risk
profiles.

**MDR** — Merchant Discount Rate. The fee the PSP charges the merchant on a
successful transaction. Revenue account at *Settlement*.

**MID** — Merchant ID. The scheme-issued identifier for a merchant under a
specific acquirer. Carried in *DE 42*.

**MTI** — Message Type Indicator. 4-digit ISO 8583 message classifier.
Examples: `0100` authorization request, `0110` authorization response,
`0200` financial request, `0400` reversal request, `0420` reversal advice,
`0500` reconciliation, `0800` network management.

**Outbox (transactional)** — Pattern where domain events are written to a DB
table inside the same transaction as the business state change, then drained to
subscribers asynchronously by a separate process. Solves the dual-write problem.

**PAN** — Primary Account Number. The 12–19 digit number on a payment card.
**Never logged, ever** — PCI cat-1 sensitive. We mask to `BIN******LAST4`
everywhere outside the vault.

**Payout** — The merchant-facing aggregate transfer. Nets out gross captures,
refunds, reserves, fees over a window (T+1 by default).

**PCI DSS** — Payment Card Industry Data Security Standard. The compliance regime
that governs cardholder data handling. We target SAQ-A for integrating merchants
(hosted fields keep them out of scope); the PSP itself targets Level 1 conceptually
(we are not actually certified — see PROJECT_BRIEF.md §1).

**Presentment** — The currency the cardholder sees on the receipt. May differ
from the *Settlement* currency. We do same-currency MVP only.

**Reason Code** — Scheme-specific dispute classification. Visa uses 10.4 (other
fraud — CNP), 13.x (services), etc. Mastercard uses 4837, 4849, 4853, etc.

**Reserve (rolling)** — Percentage of merchant captures held back per *Payout*
to cover potential disputes. Posted to *Refund Reserve* in our chart of accounts.

**Reversal** — A `0400`/`0420` message sent to undo a prior authorization or
financial message. Distinct from *Void* (merchant-initiated cancel of an unused
auth) and *Refund* (post-settlement reverse of money).

**RRN** — Retrieval Reference Number. 12-character identifier in *DE 37* that
the issuer + acquirer use to look the transaction up later. Format: `yDDDhhmmss<stan>`.

**Settlement** — The actual money movement between acquirer ↔ scheme ↔ issuer.
Triggered by the *Clearing* exchange. Distinct from *Capture* (which is the
acquirer-side intention).

**STAN** — Systems Trace Audit Number. 6-digit unique per (acquirer ↔ issuer)
pair, recycled when exhausted; in *DE 11*.

**Token (vaultless)** — Opaque `tok_<ulid>` representing a PAN. See *ADR-0004*.

**transStatus** — 3DS authentication result. `Y` authenticated, `A` attempted,
`N` not authenticated, `U` could not be performed, `R` rejected, `C` challenge
required.

**Void** — Merchant-initiated cancel of an authorization before it's captured.
On the wire: `0400` reversal. Releases the *Auth-hold*. See also: *Reversal*,
*Refund*.

---
