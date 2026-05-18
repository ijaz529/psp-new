# Shared Dockerfile for every Node app in the monorepo. Each compose service
# selects the entrypoint via `command:` — the image is identical across services.

FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
 && apk add --no-cache curl

# Copy lockfiles first to maximize cache hits.
COPY pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/vault/package.json apps/vault/
COPY apps/acquirer-host/package.json apps/acquirer-host/
COPY apps/scheme-simulator/package.json apps/scheme-simulator/
COPY apps/outbox-relay/package.json apps/outbox-relay/
COPY apps/worker/package.json apps/worker/
COPY apps/portal/package.json apps/portal/
COPY apps/checkout/package.json apps/checkout/
COPY packages/config/package.json packages/config/
COPY packages/ids/package.json packages/ids/
COPY packages/money/package.json packages/money/
COPY packages/logger/package.json packages/logger/
COPY packages/otel/package.json packages/otel/
COPY packages/errors/package.json packages/errors/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/kms/package.json packages/kms/
COPY packages/service-auth/package.json packages/service-auth/
COPY packages/events/package.json packages/events/
COPY packages/db/package.json packages/db/
COPY packages/outbox/package.json packages/outbox/
COPY packages/idempotency/package.json packages/idempotency/
COPY packages/http-server/package.json packages/http-server/
COPY packages/ledger/package.json packages/ledger/
COPY packages/vault-client/package.json packages/vault-client/
COPY packages/api-keys/package.json packages/api-keys/
COPY packages/payment-engine/package.json packages/payment-engine/
COPY packages/webhook-delivery/package.json packages/webhook-delivery/
COPY packages/iso8583/package.json packages/iso8583/
COPY packages/clearing-files/package.json packages/clearing-files/
COPY packages/payouts/package.json packages/payouts/
COPY packages/risk-rules/package.json packages/risk-rules/
COPY packages/disputes/package.json packages/disputes/
COPY packages/portal-auth/package.json packages/portal-auth/

RUN --mount=type=cache,target=/root/.pnpm pnpm install

# Source comes next; in dev we override with bind mounts in compose.
COPY apps apps
COPY packages packages
COPY tsconfig.base.json .
COPY biome.json .

USER node
