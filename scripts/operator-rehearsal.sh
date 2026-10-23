#!/bin/sh
# The launch gate's operator rehearsal, run for real on this machine against a private service
# (ARCHITECTURE.md, "Operator runbook"). Needs the two dev containers from README.md. It creates a
# private database and a bucket prefix, starts the service with visitor uploads on (for the
# rehearsal only), runs each step, and removes the database. Nothing else is touched.
#   sh scripts/operator-rehearsal.sh
# Run the same steps against staging by hand with scripts/operator-rehearsal.mjs (see the runbook).
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

admin_url=${GRAFT_TEST_DATABASE_URL:-postgres://postgres:graft@127.0.0.1:55432/postgres}
s3=${GRAFT_TEST_S3_ENDPOINT:-http://127.0.0.1:59000}
run="$(date +%s)$$"
db="graft_ops_$run"
port=${GRAFT_REHEARSAL_PORT:-3400}
secret_one="rehearsal-secret-one-0123456789"
secret_two="rehearsal-secret-two-9876543210"

for name in graft-dev-pg graft-dev-s3; do docker start "$name" >/dev/null 2>&1 || { echo "container $name is missing: see README.md"; exit 1; }; done
for _ in $(seq 1 30); do docker exec graft-dev-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sql() { docker exec graft-dev-pg psql -U postgres -q -v ON_ERROR_STOP=1 -c "$1"; }

pid=""
stop() { [ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true; pid=""; }
cleanup() { stop; sql "drop database if exists $db with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

sql "create database $db"
sh scripts/build-wasm.sh >/dev/null
cargo build -q --workspace --all-features --bins

export GRAFT_DATABASE_URL="${admin_url%/*}/$db"
export GRAFT_RENDERER_WASM="$root/target/wasm32-unknown-unknown/wasm/graft_render.wasm"
export GRAFT_BLOB_S3_BUCKET=graft-test
export GRAFT_BLOB_S3_PREFIX="ops-$run"
export GRAFT_BLOB_S3_ENDPOINT="$s3"
export GRAFT_BLOB_S3_ALLOW_HTTP=true
export GRAFT_BLOB_S3_ACCESS_KEY_ID=graftaccess
export GRAFT_BLOB_S3_SECRET_ACCESS_KEY=graftsecret12345
export GRAFT_BIND="127.0.0.1:$port"
export GRAFT_ENVIRONMENT=rehearsal
export GRAFT_UPLOADS=on
api="http://127.0.0.1:$port"

start() { # start the service with the operator secret given
  GRAFT_ADMIN_SECRET="$1" target/debug/graft-api >"${TMPDIR:-/tmp}/graft-ops-$run.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do curl -fs "$api/ready" >/dev/null 2>&1 && return 0; kill -0 "$pid" 2>/dev/null || { echo "the service stopped; see ${TMPDIR:-/tmp}/graft-ops-$run.log"; exit 1; }; sleep 1; done
}
step() { echo; echo "== $1"; shift; "$@"; }

step "migrate and seed (idempotent: twice changes nothing)" target/debug/graft-seed-chain --manifest seed/chain.json
target/debug/graft-seed-chain --manifest seed/chain.json >/dev/null
start "$secret_one"

step "health, readiness, metrics" sh -c "curl -fs $api/health && echo && curl -fs $api/ready && echo && curl -fs $api/metrics | grep -c '^graft_' | sed 's/^/graft_ metric lines: /'"
step "launch gate 1: report, hide for rights, release, withdrawn" node scripts/operator-rehearsal.mjs hide --api "$api" --secret "$secret_one"
step "launch gate 2: the kill switch" node scripts/operator-rehearsal.mjs switch --api "$api" --secret "$secret_one"

echo; echo "== runbook: rotate the operator secret (restart with a new one; the old one stops working)"
stop; start "$secret_two"
old=$(curl -s -o /dev/null -w "%{http_code}" -H "x-graft-admin-secret: $secret_one" "$api/admin/reports")
new=$(curl -s -o /dev/null -w "%{http_code}" -H "x-graft-admin-secret: $secret_two" "$api/admin/reports")
echo "old secret: $old   new secret: $new"
if [ "$old" = 200 ] || [ "$new" != 200 ]; then echo "FAIL: rotating the secret must stop the old one and accept the new one"; exit 1; fi

echo; echo "== launch gate 3: the storage threshold (a limit 1 KB above the overshoot bound, then restored)"
stop; export GRAFT_STORAGE_LIMIT_BYTES=61441000; start "$secret_two"
node scripts/operator-rehearsal.mjs storage-low --api "$api" --secret "$secret_two"
stop; unset GRAFT_STORAGE_LIMIT_BYTES; start "$secret_two"
node scripts/operator-rehearsal.mjs storage-ok --api "$api" --secret "$secret_two"

echo; echo "== runbook: replay events (rebuild the rollups from the ledger)"
target/debug/graft-rebuild-rollups
echo; echo "== runbook: remove orphaned audio (nothing recent is removed)"
target/debug/graft-blob-cleanup
echo; echo "== runbook: uploads off in an emergency (restart with the flag off; reads and flips continue)"
stop; export GRAFT_UPLOADS=off; start "$secret_two"
echo "features: $(curl -fs "$api/v1/features")"
curl -fs "$api/v1/features" | grep -q '"uploads":false'

echo; echo "rehearsal complete"
