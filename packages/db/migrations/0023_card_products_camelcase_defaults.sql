-- ===========================================================================
-- Phase 19 — fix the phase 9 snake_case product-defaults bug.
--
-- Phase 9's 0017_issuing.sql seeded paycore.card_products.default_controls
-- with snake_case JSON keys (daily_limit, mcc_blocklist). But
-- mergeControls in @psp-new/issuing reads camelCase (dailyLimit,
-- mccBlocklist), so product defaults silently never apply at auth time.
--
-- This rewrites the existing rows to camelCase. Per-card overrides
-- (paycore.cards.controls) are already camelCase thanks to Phase 18's
-- portal writes — only the product defaults seed was wrong.
--
-- Idempotent: the WHERE filters on snake_case key presence, so a
-- re-application after the rewrite matches nothing.
-- ===========================================================================

update paycore.card_products
   set default_controls = jsonb_build_object(
         'dailyLimit', (default_controls ->> 'daily_limit')::int,
         'mccBlocklist', coalesce(default_controls -> 'mcc_blocklist', '[]'::jsonb)
       )
 where default_controls ? 'daily_limit'
    or default_controls ? 'mcc_blocklist';
