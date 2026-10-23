#!/bin/sh
# The service's database client against a Postgres that offers TLS, which is what RDS (PostgreSQL 15
# and later) and Neon insist on. It starts a throwaway server with a self-signed certificate, then
# connects twice with the service's own tool (graft-rebuild-rollups, which connects and migrates):
# encrypted without checking the certificate (sslmode=require), and encrypted with the certificate
# checked against its authority (sslmode=verify-full with sslrootcert), which is how to run against
# RDS with Amazon's published CA bundle. A third connection must fail: the wrong authority.
#   sh scripts/tls-database-check.sh
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
name="graft-tls-pg-$$"
dir=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT INT TERM

cargo build -q -p graft-api --bin graft-rebuild-rollups
# A small authority and a server certificate it signed (as RDS has), plus a second, unrelated authority.
openssl req -new -x509 -days 2 -nodes -subj "/CN=graft-check-ca" -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
openssl req -new -nodes -subj "/CN=localhost" -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' > "$dir/server.ext"
openssl x509 -req -days 2 -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial -extfile "$dir/server.ext" -out "$dir/server.crt" 2>/dev/null
openssl req -new -x509 -days 2 -nodes -subj "/CN=some-other-authority" -keyout "$dir/other.key" -out "$dir/other.crt" 2>/dev/null

# The certificate and key are copied into the container and given to the postgres user inside it.
docker run -d --name "$name" -e POSTGRES_PASSWORD=graft -p 127.0.0.1:55433:5432 \
  --entrypoint sh postgres:16 -c '
    while [ ! -f /tmp/server.key ]; do sleep 0.2; done
    cp /tmp/server.key /tmp/server.crt /var/lib/postgresql/ && chown postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key' >/dev/null
docker cp "$dir/server.crt" "$name:/tmp/server.crt"
docker cp "$dir/server.key" "$name:/tmp/server.key"
for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
sleep 2

run() { GRAFT_DATABASE_URL="postgres://postgres:graft@127.0.0.1:55433/postgres?$1" target/debug/graft-rebuild-rollups; }
echo "== encrypted, certificate not checked (sslmode=require)"
run "sslmode=require"
echo "== encrypted, certificate checked against its authority (sslmode=verify-full)"
run "sslmode=verify-full&sslrootcert=$dir/ca.crt"
echo "== encrypted, certificate checked against the wrong authority: must fail"
if run "sslmode=verify-full&sslrootcert=$dir/other.crt" 2>/dev/null; then echo "FAIL: the wrong authority was accepted"; exit 1; fi
echo "refused, as it should be"
echo "tls database check passed"
