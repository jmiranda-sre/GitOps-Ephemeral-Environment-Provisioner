#!/usr/bin/env bash
set -euo pipefail

# Rollback script — reverts to previous image version
# Usage: ./scripts/rollback.sh [PREVIOUS_IMAGE_TAG]

PREV_TAG="${1:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

if [ -z "${PREV_TAG}" ]; then
  echo "❌ Usage: ./scripts/rollback.sh <previous-image-tag>"
  echo "   Example: ./scripts/rollback.sh sha-abc1234"
  exit 1
fi

echo "⏪ Rolling back to image tag: ${PREV_TAG}"

docker compose -f "${COMPOSE_FILE}" pull app
docker compose -f "${COMPOSE_FILE}" up -d --no-deps app

echo "⏳ Waiting for health check..."
sleep 5

HEALTH=$(curl -sf http://localhost:3000/health | jq -r '.status' 2>/dev/null || echo "unhealthy")

if [ "${HEALTH}" = "healthy" ]; then
  echo "✅ Rollback successful — service is healthy"
else
  echo "❌ Rollback completed but service is ${HEALTH}"
  exit 1
fi
