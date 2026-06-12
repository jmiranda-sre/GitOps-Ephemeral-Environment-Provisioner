#!/usr/bin/env bash
set -euo pipefail

# Setup script for GitHub App configuration
# Creates the .pem key file placeholder and verifies env vars

ENV_FILE="${1:-.env}"

echo "🔧 GitOps Ephemeral Environment Provisioner — Setup"
echo ""

# Check requirements
check_cmd() {
  if command -v "$1" &>/dev/null; then
    echo "  ✅ $1 found"
  else
    echo "  ❌ $1 NOT found (required)"
  fi
}

echo "Checking dependencies:"
check_cmd node
check_cmd docker
check_cmd git
echo ""

# Create .env from example if not exists
if [ ! -f "${ENV_FILE}" ]; then
  echo "📝 Creating .env from .env.example ..."
  cp .env.example "${ENV_FILE}"
  echo "  ✅ Created ${ENV_FILE} — edit with your values"
else
  echo "  ℹ️  ${ENV_FILE} already exists"
fi

# Verify critical env vars
echo ""
echo "Checking critical environment variables:"
CRITICAL_VARS=("GITHUB_APP_ID" "GITHUB_APP_PRIVATE_KEY_PATH" "GITHUB_APP_WEBHOOK_SECRET")
for var in "${CRITICAL_VARS[@]}"; do
  if grep -q "^${var}=.\+" "${ENV_FILE}" 2>/dev/null; then
    VALUE=$(grep "^${var}=" "${ENV_FILE}" | cut -d= -f2)
    if [ "${var}" = "GITHUB_APP_WEBHOOK_SECRET" ]; then
      echo "  ✅ ${var}=****(masked)"
    else
      echo "  ✅ ${var}=${VALUE}"
    fi
  else
    echo "  ❌ ${var} not set"
  fi
done

echo ""
echo "📚 Next steps:"
echo "  1. Edit ${ENV_FILE} with your GitHub App credentials"
echo "  2. Place your GitHub App private key at the path specified"
echo "  3. Run: docker compose up -d"
echo "  4. Run: ./scripts/smoke-test.sh"
echo "  5. Configure your GitHub repo webhook to point to http://your-server:3000/api/v1/webhook/github"
