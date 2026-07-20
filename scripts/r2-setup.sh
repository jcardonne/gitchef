#!/usr/bin/env bash
# One-time Cloudflare R2 setup for GitChef auto-updates, entirely via wrangler.
#
# Auth first (either is fine):
#   wrangler login                       # interactive browser OAuth
#   export CLOUDFLARE_API_TOKEN=...      # token with R2 read/write
#
# Usage:
#   ./scripts/r2-setup.sh [bucket-name]   # default: gitchef-updates
#
# Creates the bucket, enables its public r2.dev URL, and prints the endpoint to
# paste into src-tauri/tauri.conf.json (plugins.updater.endpoints) and the
# GitHub Actions variable R2_PUBLIC_URL.
set -euo pipefail

BUCKET="${1:-gitchef-updates}"
WRANGLER="npx --yes wrangler@4"

echo "==> Creating bucket '$BUCKET' (ignored if it already exists)"
$WRANGLER r2 bucket create "$BUCKET" || true

echo "==> Enabling public r2.dev access"
$WRANGLER r2 bucket dev-url enable "$BUCKET"

echo
echo "==> Public URL"
$WRANGLER r2 bucket dev-url get "$BUCKET"

echo
echo "Next:"
echo "  1. Copy the https://pub-xxxx.r2.dev URL above."
echo "  2. Set it as the GitHub Actions variable R2_PUBLIC_URL (no trailing slash)."
echo "     Do NOT paste it into src-tauri/tauri.conf.json: the repo keeps the"
echo "     REPLACE_WITH_R2_DEV_URL placeholder on purpose and the release workflow"
echo "     substitutes it at build time. Committing the real URL makes that"
echo "     substitution match nothing (the release then fails loudly)."
echo "  3. Set GitHub secret CLOUDFLARE_API_TOKEN + variables R2_ACCOUNT_ID, R2_BUCKET."
