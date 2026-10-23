#!/bin/sh
# What the deploy does, on this machine, with the real service image: the release step (migrate, seed,
# check the seeded chain against the committed snapshot), then the service from the same image, asked
# for its readiness, its features and the seeded chain. The image is built first unless IMAGE is set.
# Needs Docker and the two dev containers from README.md; it uses a private database and bucket prefix.
#   sh scripts/service-image-check.sh
set -eu
cd "$(dirname "$0")/.."
image=${IMAGE:-graft-service:check}
[ -n "${IMAGE:-}" ] || docker build -q -f Dockerfile.service -t "$image" . >/dev/null

run="$(date +%s)$$"
db="graft_img_$run"
port=${GRAFT_IMAGE_CHECK_PORT:-3700}
name="graft-img-$run"
for c in graft-dev-pg graft-dev-s3; do docker start "$c" >/dev/null 2>&1 || { echo "container $c is missing: see README.md"; exit 1; }; done
for _ in $(seq 1 30); do docker exec graft-dev-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec graft-dev-pg psql -U postgres -q -c "create database $db"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker exec graft-dev-pg psql -U postgres -q -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# From inside the container the machine's servers are at this name.
host=host.docker.internal
env_args="-e GRAFT_DATABASE_URL=postgres://postgres:graft@$host:55432/$db
 -e GRAFT_BLOB_S3_BUCKET=graft-test -e GRAFT_BLOB_S3_PREFIX=img-$run -e GRAFT_BLOB_S3_ENDPOINT=http://$host:59000 -e GRAFT_BLOB_S3_ALLOW_HTTP=true
 -e GRAFT_BLOB_S3_ACCESS_KEY_ID=graftaccess -e GRAFT_BLOB_S3_SECRET_ACCESS_KEY=graftsecret12345
 -e GRAFT_ADMIN_SECRET=image-check-secret-0123456789 -e GRAFT_ENVIRONMENT=image-check"

echo "== the container runs as a non-root user"
uid=$(docker run --rm "$image" sh -c 'id -u')
if [ "$uid" = 0 ]; then echo "FAIL: the image runs as root"; exit 1; fi
echo "ok (uid $uid)"
echo "== release step: migrate, seed, and check the seeded chain against the committed snapshot"
# shellcheck disable=SC2086
docker run --rm $env_args "$image" graft-seed-chain --manifest seed/chain.json --check-snapshot web
echo "== the service, from the same image"
# shellcheck disable=SC2086
docker run -d --name "$name" $env_args -e GRAFT_CORS_ORIGINS=http://127.0.0.1:3100 -p "127.0.0.1:$port:8080" "$image" >/dev/null
for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$port/ready" >/dev/null 2>&1 && break; docker ps -q -f name="$name" | grep -q . || { docker logs "$name" | tail -5; exit 1; }; sleep 1; done
echo "ready:    $(curl -fs "http://127.0.0.1:$port/ready")"
echo "features: $(curl -fs "http://127.0.0.1:$port/v1/features")"
leaf=$(node -e 'const s=JSON.parse(require("fs").readFileSync("web/snapshot/chain.json","utf8")).stages; console.log(s[s.length-1].id)')
stages=$(curl -fs "http://127.0.0.1:$port/v1/chains/$leaf" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).stages.length))')
want=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("web/snapshot/chain.json","utf8")).stages.length)')
echo "the seeded chain reads back with $stages stages (the snapshot has $want)"
if [ "$stages" != "$want" ]; then echo "FAIL: the service's chain differs from the snapshot's"; exit 1; fi
echo "service image check passed"
