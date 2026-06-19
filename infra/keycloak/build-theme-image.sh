#!/usr/bin/env bash
# Build the per-network Keycloak theme init-container image.
#
# Reads brand args from `config/<network>/keycloak.env` so the same
# strings that drive the docker-compose stack also bake the k8s image.
# Outputs `aggregator-kc-theme:<network>-<tag>`.
#
# Usage:
#   ./infra/keycloak/build-theme-image.sh <network> [<image-tag>] [<registry>]
#   ./infra/keycloak/build-theme-image.sh purple_dot v1 registry.your.co
#
# Defaults: network=blue_dot, tag=local, registry= (omit → local docker).
set -euo pipefail

NETWORK="${1:-blue_dot}"
TAG="${2:-local}"
REGISTRY="${3:-}"

ENV_FILE="config/${NETWORK}/keycloak.env"
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

IMAGE="aggregator-kc-theme:${NETWORK}-${TAG}"
if [[ -n "$REGISTRY" ]]; then
  IMAGE="${REGISTRY}/${IMAGE}"
fi

echo "→ building $IMAGE from $ENV_FILE"
docker build \
  -f infra/keycloak/themes.Dockerfile \
  "${BUILD_ARGS[@]}" \
  -t "$IMAGE" \
  .

echo "✓ built $IMAGE"
echo
echo "Push (optional):"
echo "  docker push $IMAGE"
echo
echo "Use as k8s initContainer:"
echo "  - name: themes-init"
echo "    image: $IMAGE"
echo "    volumeMounts:"
echo "      - { name: kc-themes, mountPath: /shared }"
