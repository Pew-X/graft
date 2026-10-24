#!/bin/sh
# The whole thing on this machine, for looking at and trying by hand: Postgres and an S3-compatible
# server (the throwaway containers from README.md), the service with visitor uploads on, the seeded
# chain, and the built site at http://127.0.0.1:3100. Stop it with Ctrl-C.
#   sh scripts/dev-local.sh              serve on 127.0.0.1 only
#   sh scripts/dev-local.sh --no-uploads leave visitor uploads off, as every environment ships
# The database "graft_local" and the bucket prefix "local" are kept between runs; nothing else is touched.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

uploads=on
[ "${1:-}" = "--no-uploads" ] && uploads=off

admin_url=${GRAFT_TEST_DATABASE_URL:-postgres://postgres:graft@127.0.0.1:55432/postgres}
s3=${GRAFT_TEST_S3_ENDPOINT:-http://127.0.0.1:59000}
db=graft_local
api_port=${GRAFT_SERVICE_API_PORT:-3300}
site_port=${GRAFT_SITE_PORT:-3100}

for name in graft-dev-pg graft-dev-s3; do
  docker start "$name" >/dev/null 2>&1 || { echo "container $name is missing: see README.md, \"Run it\""; exit 1; }
done
for _ in $(seq 1 30); do
  docker exec graft-dev-pg pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec graft-dev-pg psql -U postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
  || docker exec graft-dev-pg psql -U postgres -q -c "create database $db"
# The bucket may already exist; that is fine.
curl -s -o /dev/null -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user graftaccess:graftsecret12345 "$s3/graft-test" || true

api_pid=""
cleanup() { [ -n "$api_pid" ] && kill "$api_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

sh scripts/build-wasm.sh
cargo build -q --workspace --all-features --bins

export GRAFT_DATABASE_URL="${admin_url%/*}/$db"
export GRAFT_RENDERER_WASM="$root/target/wasm32-unknown-unknown/wasm/graft_render.wasm"
export GRAFT_BLOB_S3_BUCKET=graft-test
export GRAFT_BLOB_S3_PREFIX=local
export GRAFT_BLOB_S3_ENDPOINT="$s3"
export GRAFT_BLOB_S3_ALLOW_HTTP=true
export GRAFT_BLOB_S3_ACCESS_KEY_ID=graftaccess
export GRAFT_BLOB_S3_SECRET_ACCESS_KEY=graftsecret12345
export GRAFT_BIND="127.0.0.1:$api_port"
export GRAFT_CORS_ORIGINS="http://127.0.0.1:$site_port"
export GRAFT_ADMIN_SECRET=local-admin-secret-0123456789
export GRAFT_ENVIRONMENT=local
export GRAFT_UPLOADS="$uploads"

target/debug/graft-seed-chain --manifest seed/chain.json >/dev/null
target/debug/graft-api &
api_pid=$!
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$api_port/ready" >/dev/null 2>&1 && break
  kill -0 "$api_pid" 2>/dev/null || { echo "the service stopped"; exit 1; }
  sleep 1
done

cd web
# The site's content security policy lets pages talk to exactly these origins, besides themselves.
GRAFT_CONNECT_ORIGINS="http://127.0.0.1:$api_port,$s3" pnpm build
echo "site: http://127.0.0.1:$site_port   service: http://127.0.0.1:$api_port   uploads: $uploads"
echo "operator page: http://127.0.0.1:$site_port/admin   secret: $GRAFT_ADMIN_SECRET (local only)"
GRAFT_API_URL="http://127.0.0.1:$api_port" GRAFT_PUBLIC_API_URL="http://127.0.0.1:$api_port" \
  pnpm start -H 127.0.0.1 -p "$site_port"
