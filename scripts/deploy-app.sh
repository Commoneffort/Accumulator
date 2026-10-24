#!/usr/bin/env bash
# Build a frontend and publish it to Vercel.
#   scripts/deploy-app.sh                      -> app/          -> https://accumulator-x1.vercel.app
#   scripts/deploy-app.sh app-classic accumulator-classic       -> https://accumulator-classic.vercel.app
# Token comes from .env (VERCEL_TOKEN), never from the command line.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="${1:-app}"
project="${2:-accumulator-x1}"
set -a; . "$root/.env"; set +a
(cd "$root/$src" && npm run build)
out="$root/deploy/$project"  # folder name = Vercel project name
rm -rf "$out" && mkdir -p "$root/deploy" && cp -r "$root/$src/dist" "$out"
cd "$out"
npx --yes vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN" \
  --scope katrinvalkyrie-9987s-projects 2>&1 | grep -E "Production|Aliased|Error" || true
code=$(curl -s -o /dev/null -w "%{http_code}" "https://$project.vercel.app")
echo "https://$project.vercel.app -> HTTP $code"
