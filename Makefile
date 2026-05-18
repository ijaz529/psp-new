# psp-new — developer Makefile.
# All targets assume Docker Desktop and pnpm 10+ are installed.

SHELL := /bin/bash
COMPOSE := docker compose
COMPOSE_FULL := docker compose -f docker-compose.yml -f docker-compose.observability.yml

.PHONY: help up up-full down logs reset-db migrate ps shell-pg \
        typecheck lint test test-watch build clean e2e \
        ensure-env install

help:
	@echo "psp-new — common targets"
	@echo ""
	@echo "  make install       pnpm install across workspaces"
	@echo "  make up            bring up core stack (postgres, redis, app services)"
	@echo "  make up-full       core + observability (otel-collector, jaeger, prometheus, grafana)"
	@echo "  make down          stop everything (preserves volumes)"
	@echo "  make logs          tail compose logs"
	@echo "  make ps            show running services"
	@echo "  make reset-db      DROP + recreate dev DB"
	@echo "  make migrate       apply migrations to running postgres"
	@echo "  make typecheck     tsc --noEmit across workspaces"
	@echo "  make lint          biome check"
	@echo "  make test          vitest across workspaces"
	@echo "  make test-watch    vitest in watch mode"
	@echo "  make build         turbo build (source-only apps currently no-op)"
	@echo "  make clean         remove node_modules/.cache + .turbo + dist"
	@echo "  make e2e           full-stack smoke (requires up-full)"

install:
	pnpm install

ensure-env:
	@if [ ! -f .env ]; then cp .env.example .env; echo "created .env from .env.example"; fi

up: ensure-env
	$(COMPOSE) up -d --build

up-full: ensure-env
	$(COMPOSE_FULL) up -d --build

down:
	$(COMPOSE_FULL) down

logs:
	$(COMPOSE_FULL) logs -f --tail=100

ps:
	$(COMPOSE_FULL) ps

reset-db:
	pnpm --filter @psp-new/db reset

migrate:
	pnpm --filter @psp-new/db migrate

typecheck:
	pnpm typecheck

lint:
	pnpm lint

test:
	pnpm test

test-watch:
	pnpm test:watch

build:
	pnpm build

clean:
	pnpm clean

e2e:
	pnpm smoke
