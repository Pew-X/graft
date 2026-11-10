#!/bin/sh
# The real service with the event queue switched on, against an SQS emulator and a private database:
# events sent to the service reach the rollups through the queue, and a message nobody can read ends in
# the dead-letter queue and blocks nothing. It needs Postgres (README.md, "Run it"), an SQS emulator
# (README.md, "Run the queue tests") and the AWS command line. Run it from anywhere:
#   GRAFT_TEST_SQS_ENDPOINT=http://127.0.0.1:59324 sh scripts/queue-e2e.sh
# Nothing here touches anything but the private database it creates and two queues it makes and removes.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

admin_url=${GRAFT_TEST_DATABASE_URL:-postgres://postgres:graft@127.0.0.1:55432/postgres}
s3=${GRAFT_TEST_S3_ENDPOINT:-http://127.0.0.1:59000}
sqs=${GRAFT_TEST_SQS_ENDPOINT:?GRAFT_TEST_SQS_ENDPOINT must name an SQS emulator, for example http://127.0.0.1:59324}
run="$(date +%s)$$"
db="graft_queue_$run"
api_port=${GRAFT_SERVICE_API_PORT:-3300}
admin=queue-e2e-admin-secret-0123456789

command -v aws >/dev/null 2>&1 || { echo "the AWS command line is needed (it only talks to the emulator here)"; exit 2; }
export AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
q() { aws --endpoint-url "$sqs" sqs "$@"; }

if command -v psql >/dev/null 2>&1; then
  sql() { psql "$admin_url" -q -v ON_ERROR_STOP=1 -c "$1"; }
else
  sql() { docker exec graft-dev-pg psql -U postgres -q -v ON_ERROR_STOP=1 -c "$1"; }
fi

api_pid=""
cleanup() {
  [ -n "$api_pid" ] && kill "$api_pid" 2>/dev/null || true
  q delete-queue --queue-url "$sqs/000000000000/graft-qe-events-$run" >/dev/null 2>&1 || true
  q delete-queue --queue-url "$sqs/000000000000/graft-qe-dead-$run" >/dev/null 2>&1 || true
  sql "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sql "create database $db"
q create-queue --queue-name "graft-qe-dead-$run" >/dev/null
dead_arn=$(q get-queue-attributes --queue-url "$sqs/000000000000/graft-qe-dead-$run" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
q create-queue --queue-name "graft-qe-events-$run" --attributes "{\"VisibilityTimeout\":\"1\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dead_arn\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" >/dev/null
queue="$sqs/000000000000/graft-qe-events-$run"
dead="$sqs/000000000000/graft-qe-dead-$run"

sh scripts/build-wasm.sh
cargo build -q --workspace --all-features --bins

export GRAFT_DATABASE_URL="${admin_url%/*}/$db"
export GRAFT_RENDERER_WASM="$root/target/wasm32-unknown-unknown/wasm/graft_render.wasm"
export GRAFT_BLOB_S3_BUCKET=graft-test
export GRAFT_BLOB_S3_PREFIX="qe-$run"
export GRAFT_BLOB_S3_ENDPOINT="$s3"
export GRAFT_BLOB_S3_ALLOW_HTTP=true
export GRAFT_BLOB_S3_ACCESS_KEY_ID=graftaccess
export GRAFT_BLOB_S3_SECRET_ACCESS_KEY=graftsecret12345
export GRAFT_BIND="127.0.0.1:$api_port"
export GRAFT_CORS_ORIGINS=http://127.0.0.1:3100
export GRAFT_ADMIN_SECRET="$admin"
export GRAFT_ENVIRONMENT=queue-e2e
export GRAFT_INGEST_PER_IP=100000
export GRAFT_EVENT_QUEUE_URL="$queue"
export GRAFT_EVENT_QUEUE_ENDPOINT="$sqs"
export GRAFT_RELAY_INTERVAL_MS=200

target/debug/graft-seed-chain --manifest seed/chain.json >/dev/null
target/debug/graft-api >"${TMPDIR:-/tmp}/graft-queue-e2e-$run.log" 2>&1 &
api_pid=$!
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$api_port/ready" >/dev/null 2>&1 && break
  kill -0 "$api_pid" 2>/dev/null || { echo "the service stopped; see ${TMPDIR:-/tmp}/graft-queue-e2e-$run.log"; exit 1; }
  sleep 1
done
curl -fs "http://127.0.0.1:$api_port/ready" >/dev/null

# one message nobody can read, and three events sent the way the browser sends them
q send-message --queue-url "$queue" --message-body "not an event message" >/dev/null
now=$(node -e 'console.log(Date.now())')
event() { printf '{"event_id":"queue-e2e-%s-%s-0123456789","session_id":"queue-e2e-session-01","kind":"roll_opened","occurred_at_ms":%s,"publication_id":"es1418qka9yt"}' "$run" "$1" "$now"; }
body="{\"events\":[$(event 1),$(event 2),$(event 3)]}"
curl -fs -X POST -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$api_port/v1/events" >/dev/null

total() {
  curl -fs -H "x-graft-admin-secret: $admin" "http://127.0.0.1:$api_port/admin/rollups?hours=2" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);let n=0;for(const h of j.hours)n+=h.counts.roll_opened||0;console.log(n)})'
}
count() { q get-queue-attributes --queue-url "$1" --attribute-names All --query "Attributes.$2" --output text; }

for _ in $(seq 1 40); do
  [ "$(total)" = "3" ] && break
  sleep 1
done
[ "$(total)" = "3" ] || { echo "FAIL: the three events did not reach the rollups through the queue (saw $(total))"; exit 1; }
echo "ok: three events reached the rollups through the queue"

for _ in $(seq 1 30); do
  [ "$(count "$dead" ApproximateNumberOfMessages)" = "1" ] && break
  sleep 1
done
[ "$(count "$dead" ApproximateNumberOfMessages)" = "1" ] || { echo "FAIL: the unreadable message did not reach the dead-letter queue"; exit 1; }
echo "ok: the unreadable message is in the dead-letter queue"
[ "$(count "$queue" ApproximateNumberOfMessages)" = "0" ] && [ "$(count "$queue" ApproximateNumberOfMessagesNotVisible)" = "0" ] || { echo "FAIL: the queue is not empty"; exit 1; }
echo "ok: nothing is left in the queue, and the count is still 3: $(total)"
[ "$(total)" = "3" ]
