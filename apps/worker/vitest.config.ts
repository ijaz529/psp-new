import sharedVitestConfig from '@psp-new/config/vitest.config.shared';
import { defineConfig, mergeConfig } from 'vitest/config';

// Worker integration tests post to shared global PSP ledger accounts
// (psp_cash_at_bank, scheme_receivable, clearing_adjustments, …), so
// parallel test files race each other's balance assertions. Run files
// one at a time.
export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      fileParallelism: false,
    },
  }),
);
