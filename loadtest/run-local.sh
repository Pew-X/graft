#!/bin/sh
# A dry run of the load test on this machine, to prove the script works end to end. It is NOT the
# measurement: the numbers it prints come from a laptop, a local database and caps lifted out of the
# way, and mean nothing about a deployment. The real run is against staging (see the workflow).
#   sh loadtest/run-local.sh            a short run (profile smoke)
#   PROFILE=full sh loadtest/run-local.sh
# Needs Docker and the two dev containers from README.md; k6 runs from a pinned container image.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

K6_IMAGE=grafana/k6@sha256:f21270290d702cbf0a7d6ba5d7ed100b63bcb233b558b885ed787547b3488279 # grafana/k6:1.0.0
admin_url=${GRAFT_TEST_DATABASE_URL:-postgres://postgres:graft@127.0.0.1:55432/postgres}
s3=${GRAFT_TEST_S3_ENDPOINT:-http://127.0.0.1:59000}
run="$(date +%s)$$"
db="graft_load_$run"
port=${GRAFT_LOADTEST_PORT:-3500}
out="${TMPDIR:-/tmp}/graft-loadtest-$run"
mkdir -p "$out"

for name in graft-dev-pg graft-dev-s3; do docker start "$name" >/dev/null 2>&1 || { echo "container $name is missing: see README.md"; exit 1; }; done
for _ in $(seq 1 30); do docker exec graft-dev-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sql() { docker exec graft-dev-pg psql -U postgres -q -v ON_ERROR_STOP=1 -c "$1"; }
pid=""
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; sql "drop database if exists $db with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
sql "create database $db"

sh scripts/build-wasm.sh >/dev/null
cargo build -q --workspace --all-features --bins
export GRAFT_DATABASE_URL="${admin_url%/*}/$db"
export GRAFT_RENDERER_WASM="$root/target/wasm32-unknown-unknown/wasm/graft_render.wasm"
export GRAFT_BLOB_S3_BUCKET=graft-test GRAFT_BLOB_S3_PREFIX="load-$run" GRAFT_BLOB_S3_ENDPOINT="$s3" GRAFT_BLOB_S3_ALLOW_HTTP=true
export GRAFT_BLOB_S3_ACCESS_KEY_ID=graftaccess GRAFT_BLOB_S3_SECRET_ACCESS_KEY=graftsecret12345
export GRAFT_BIND="127.0.0.1:$port" GRAFT_ENVIRONMENT=loadtest-local
# /metrics needs the operator secret; this one lives only as long as the run.
export GRAFT_ADMIN_SECRET="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
# The limits are part of the system under test, but a dry run on one address would only meet them.
# They are lifted here and the run says so; a staging run states which it used.
export GRAFT_PUBLISH_PER_IP=1000000 GRAFT_REPORT_PER_IP=1000000 GRAFT_INGEST_PER_IP=1000000
export GRAFT_GLOBAL_PUBLISH_PER_HOUR=1000000 GRAFT_GLOBAL_PUBLISH_BURST=100000
export GRAFT_STORAGE_LIMIT_BYTES=900000000000000 GRAFT_MAX_FORKS_PER_STAGE_PER_HOUR=1000000

target/debug/graft-seed-chain --manifest seed/chain.json >/dev/null
target/debug/graft-api >"$out/service.log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$port/ready" >/dev/null 2>&1 && break; kill -0 "$pid" 2>/dev/null || { echo "the service stopped; see $out/service.log"; exit 1; }; sleep 1; done

leaf=$(node -e 'const s=JSON.parse(require("fs").readFileSync("web/snapshot/chain.json","utf8")).stages; console.log(s[s.length-1].id)')
echo "seeded chain's last stage: $leaf; service on port $port; output in $out"
status=0
docker run --rm -v "$root/loadtest:/loadtest:ro" -v "$out:/out" \
  -e BASE_URL="http://host.docker.internal:$port" -e SEED_LEAF="$leaf" -e PROFILE="${PROFILE:-smoke}" -e OPERATOR_SECRET="$GRAFT_ADMIN_SECRET" \
  -e SUMMARY_OUT=/out/summary.json "$K6_IMAGE" run /loadtest/graft.js || status=$?
echo; echo "== reconcile (client counts against the service's counters and the database)"
node loadtest/reconcile.mjs "$out/summary.json" || status=$?
echo "caps lifted for this dry run; not a measurement"
exit $status
