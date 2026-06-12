#!/usr/bin/env bash
set -euo pipefail

# Smoke test — runs after deploy to verify the service is alive
# Usage: ./scripts/smoke-test.sh [BASE_URL]

BASE_URL="${1:-http://localhost:3000}"
TIMEOUT=10

echo "🔍 Smoke testing: ${BASE_URL}"

# 1. Health check
echo -n "  Health check ... "
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" "${BASE_URL}/health") || STATUS="000"
if [ "${STATUS}" = "200" ]; then
  echo "✅ (${STATUS})"
else
  echo "❌ (${STATUS})"
  exit 1
fi

# 2. Metrics endpoint
echo -n "  Metrics endpoint ... "
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" "${BASE_URL}/metrics") || STATUS="000"
if [ "${STATUS}" = "200" ]; then
  echo "✅ (${STATUS})"
else
  echo "❌ (${STATUS})"
  exit 1
fi

# 3. Environments list
echo -n "  Environments list ... "
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" "${BASE_URL}/api/v1/environments") || STATUS="000"
if [ "${STATUS}" = "200" ]; then
  echo "✅ (${STATUS})"
else
  echo "❌ (${STATUS})"
  exit 1
fi

echo ""
echo "✅ All smoke tests passed"
