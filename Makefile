.PHONY: help setup hosts env dev up down logs ps reset psql redis-cli mc kc rebuild-web rebuild-keycloak kc-plugin kc-logs

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: env hosts ## One-shot: bootstrap .env + add `127.0.0.1 keycloak` to /etc/hosts.
	@echo ""
	@echo "Setup complete. Edit .env (fill change-me-* + secrets), then run 'make up'."

env: ## Copy infra/env.template → .env if missing, chmod 600.
	@if [ -f .env ]; then \
		echo ".env already exists — leaving untouched."; \
	else \
		cp infra/env.template .env; \
		chmod 600 .env; \
		echo "Created .env from infra/env.template (mode 600)."; \
		echo "Generate secrets:  openssl rand -hex 32"; \
	fi

hosts: ## Add `127.0.0.1 keycloak` to /etc/hosts (needed when running web in docker).
	@if grep -q "^127\.0\.0\.1[[:space:]]\+keycloak\b" /etc/hosts; then \
		echo "/etc/hosts already maps keycloak → 127.0.0.1 — skipping."; \
	else \
		echo "Adding '127.0.0.1 keycloak' to /etc/hosts (sudo required)..."; \
		echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts > /dev/null; \
		echo "Done."; \
	fi

dev: up ## Alias for `up`. Brings the full local stack up.

up: ## Start all foundations + apps in the background.
	@test -f .env || (echo ".env missing — run 'make setup' first" && exit 1)
	docker compose -f docker-compose-ebs.yml up -d --build

down: ## Stop and remove all containers (data volumes preserved).
	docker compose down

reset: ## Stop everything and wipe data volumes. Destructive.
	docker compose down -v

logs: ## Tail logs for all services.
	docker compose logs -f

ps: ## Show service status.
	docker compose ps

psql: ## Open psql against the local Postgres.
	docker compose exec postgres psql -U aggregator -d aggregator

redis-cli: ## Open redis-cli against the local Redis.
	docker compose exec redis redis-cli

mc: ## Open a one-shot MinIO mc shell against the local server.
	docker run --rm -it --network aggregator-dpg_default \
		-e MC_HOST_local=http://$${MINIO_ROOT_USER:-minioadmin}:$${MINIO_ROOT_PASSWORD:-minioadmin}@minio:9000 \
		minio/mc sh

kc: ## Print Keycloak admin URL.
	@echo "http://localhost:8080  (admin / \$${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin})"

rebuild-web: ## Rebuild the web image and restart only the web container.
	pnpm --filter @aggregator-dpg/web build
	docker compose build web
	docker compose up -d web

KC_PLUGIN_REPO ?= ../keycloak-otp-authenticator
KC_PLUGIN_JAR  := keycloak-otp-1.0.0-SNAPSHOT.jar

kc-plugin: ## Build the Keycloak OTP plugin JAR and copy into infra/keycloak/providers.
	cd $(KC_PLUGIN_REPO) && ./mvnw -q clean package -DskipTests
	cp $(KC_PLUGIN_REPO)/dist/target/$(KC_PLUGIN_JAR) infra/keycloak/providers/
	@echo "Copied $(KC_PLUGIN_JAR) → infra/keycloak/providers/"

rebuild-keycloak: kc-plugin ## Rebuild the OTP plugin and restart Keycloak (re-imports realm on first boot only).
	docker compose restart keycloak
	@echo "Tail with: make kc-logs"

kc-logs: ## Tail Keycloak logs.
	docker compose logs -f keycloak
