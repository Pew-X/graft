#!/bin/sh
# The service browser tests: the real service on a private database and bucket prefix, the seeded
# chain, the built site, and Playwright driving it. Needs Postgres and the S3-compatible server from
# README.md ("Run it") and Chromium for Playwright. Run it from anywhere:
#   sh scripts/service-e2e.sh                      all of web/e2e, including web/e2e/service
#   sh scripts/service-e2e.sh e2e/service/chain      only the matching specs
# Nothing here touches anything but the private database it creates and a prefix in the test bucket.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

admin_url=${GRAFT_TEST_DATABASE_URL:-postgres://postgres:graft@127.0.0.1:55432/postgres}
s3=${GRAFT_TEST_S3_ENDPOINT:-http://127.0.0.1:59000}
run="$(date +%s)$$"
db="graft_svc_$run"
api_port=${GRAFT_SERVICE_API_PORT:-3300}

# psql from the machine if there is one, else from the dev container.
if command -v psql >/dev/null 2>&1; then
  sql() { psql "$admin_url" -q -v ON_ERROR_STOP=1 -c "$1"; }
else
  sql() { docker exec graft-dev-pg psql -U postgres -q -v ON_ERROR_STOP=1 -c "$1"; }
fi

api_pid=""
cleanup() {
  [ -n "$api_pid" ] && kill "$api_pid" 2>/dev/null || true
  sql "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sql "create database $db"

wasm="$root/target/wasm32-unknown-unknown/wasm/graft_render.wasm"
[ -f "$wasm" ] || sh scripts/build-wasm.sh
cargo build -q -p graft-api --bins

export GRAFT_DATABASE_URL="${admin_url%/*}/$db"
export GRAFT_RENDERER_WASM="$wasm"
export GRAFT_BLOB_S3_BUCKET=graft-test
export GRAFT_BLOB_S3_PREFIX="svc-$run"
export GRAFT_BLOB_S3_ENDPOINT="$s3"
export GRAFT_BLOB_S3_ALLOW_HTTP=true
export GRAFT_BLOB_S3_ACCESS_KEY_ID=graftaccess
export GRAFT_BLOB_S3_SECRET_ACCESS_KEY=graftsecret12345
export GRAFT_BIND="127.0.0.1:$api_port"
export GRAFT_CORS_ORIGINS=http://127.0.0.1:3100
export GRAFT_ADMIN_SECRET=svc-test-admin-secret-0123456789
export GRAFT_ENVIRONMENT=svc-test
# The abuse limits are tested in the Rust suite. Here one address publishes dozens of flips of the
# same stage within a minute, so they are lifted well out of the way.
export GRAFT_PUBLISH_PER_IP=100000
export GRAFT_REPORT_PER_IP=100000
export GRAFT_INGEST_PER_IP=100000
export GRAFT_GLOBAL_PUBLISH_PER_HOUR=100000
export GRAFT_GLOBAL_PUBLISH_BURST=1000
# The storage limit must exceed what the cap above could admit before the total is read again.
export GRAFT_STORAGE_LIMIT_BYTES=900000000000000
export GRAFT_MAX_FORKS_PER_STAGE_PER_HOUR=100000

target/debug/graft-seed-chain --manifest seed/chain.json >/dev/null
target/debug/graft-api >"${TMPDIR:-/tmp}/graft-svc-api-$run.log" 2>&1 &
api_pid=$!
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$api_port/ready" >/dev/null 2>&1 && break
  kill -0 "$api_pid" 2>/dev/null || { echo "the service stopped; see ${TMPDIR:-/tmp}/graft-svc-api-$run.log"; exit 1; }
  sleep 1
done
curl -fs "http://127.0.0.1:$api_port/ready" >/dev/null

cd web
GRAFT_SERVICE_E2E=1 \
GRAFT_API_URL="http://127.0.0.1:$api_port" \
GRAFT_SERVICE_S3="$s3" \
pnpm exec playwright test "$@"
