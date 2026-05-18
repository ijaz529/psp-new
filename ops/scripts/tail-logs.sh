#!/usr/bin/env bash
set -euo pipefail
exec docker compose -f docker-compose.yml -f docker-compose.observability.yml logs -f --tail=200 "$@"
