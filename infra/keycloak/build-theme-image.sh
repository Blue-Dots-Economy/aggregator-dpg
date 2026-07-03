#!/usr/bin/env bash
# Build the per-network (and optionally per-brand) Keycloak theme init-container image.
#
# Reads brand args from `config/<network>[/<brand>]/keycloak.env` so the same
# strings that drive the docker-compose stack also bake the k8s image.
# Outputs `aggregator-kc-theme:<network>[-<brand>]-<tag>`.
#
# Usage:
#   ./infra/keycloak/build-theme-image.sh <network> [<brand>] [<image-tag>] [<registry>]
#   ./infra/keycloak/build-theme-image.sh blue_dot               # → aggregator-kc-theme:blue_dot-local
#   ./infra/keycloak/build-theme-image.sh blue_dot upsdm v1      # → aggregator-kc-theme:blue_dot-upsdm-v1
#   ./infra/keycloak/build-theme-image.sh purple_dot "" v1 registry.your.co
#
# Defaults: network=blue_dot, brand= (omit → base network env), tag=local, registry= (omit → local docker).
# Set DRY_RUN=1 to print the resolved env_file + image tag and exit without building.
set -euo pipefail

NETWORK="${1:-blue_dot}"
BRAND="${2:-}"
TAG="${3:-local}"
REGISTRY="${4:-}"

if [[ -n "$BRAND" ]]; then
  ENV_FILE="config/${NETWORK}/${BRAND}/keycloak.env"
  IMAGE_NAME="aggregator-kc-theme:${NETWORK}-${BRAND}-${TAG}"
else
  ENV_FILE="config/${NETWORK}/keycloak.env"
  IMAGE_NAME="aggregator-kc-theme:${NETWORK}-${TAG}"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — run from repo root" >&2
  exit 1
fi

# Map every KEY=value line in the env file to --build-arg KEY=value.
# Skip blanks + comments. Quoted values: keycloak.env entries are plain
# `KEY=value` (no quoting), so a direct mapping is safe.
BUILD_ARGS=()
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  BUILD_ARGS+=("--build-arg" "$line")
done < "$ENV_FILE"

BUILD_ARGS+=("--build-arg" "NETWORK=${NETWORK}")

if [[ -n "$REGISTRY" ]]; then
  IMAGE_NAME="${REGISTRY}/${IMAGE_NAME}"
fi

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "DRY_RUN: env_file=$ENV_FILE image=$IMAGE_NAME"
  exit 0
fi

echo "→ building $IMAGE_NAME from $ENV_FILE"
docker build \
  -f infra/keycloak/themes.Dockerfile \
  "${BUILD_ARGS[@]}" \
  -t "$IMAGE_NAME" \
  .

echo "✓ built $IMAGE_NAME"
echo
echo "Push (optional):"
echo "  docker push $IMAGE_NAME"
echo
echo "Use as k8s initContainer:"
echo "  - name: themes-init"
echo "    image: $IMAGE_NAME"
echo "    volumeMounts:"
echo "      - { name: kc-themes, mountPath: /shared }"
