#!/usr/bin/env bash
#
# Pull the latest code, re-run the checks, apply any new D1 migrations, and
# redeploy. For the client's technical person or the integrator on a support
# call. Non-interactive; fails loudly on any step. Safe to re-run.
#
#   ./scripts/update.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

grep -q '"name": "eh-payroll-sync"' package.json 2>/dev/null \
  || { echo "run this from the eh-payroll-sync repo root" >&2; exit 1; }

echo "▸ pulling latest code"
git pull --ff-only

echo "▸ installing dependencies"
npm ci

echo "▸ running the test suite"
npm test

# The deploy config comes from wrangler.jsonc + .dev.vars, checked against the
# Cloudflare account and the live Worker before anything changes. Never
# deploy wrangler.jsonc itself: it is the blank template.
echo "▸ building the deploy config and checking it against the live Worker"
npm run --silent deploy:config -- --check-live

echo "▸ applying new D1 migrations (remote)"
npx --yes wrangler d1 migrations apply eh-payroll-sync --remote --config wrangler.deploy.json

echo "▸ deploying"
deploy_out=$(npx --yes wrangler deploy --config wrangler.deploy.json 2>&1)
printf '%s\n' "$deploy_out"

url=$(printf '%s' "$deploy_out" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)
if [[ -n "$url" ]]; then
  echo "▸ health check: $url/health"
  curl -fsS "$url/health" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);if(!h.ok){console.error("  /health not ok:",JSON.stringify(h));process.exit(1)}console.log("  ok — d1:",h.d1,"fieldMap:",h.fieldMap)})'
else
  echo "  (could not read the deployed URL — check $url/health manually)" >&2
fi

echo "✓ update complete"
