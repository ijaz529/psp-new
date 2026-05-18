#!/usr/bin/env bash
# Drops the dev database schemas and re-runs migrations against the running compose stack.
set -euo pipefail
exec pnpm --filter @psp-new/db reset
