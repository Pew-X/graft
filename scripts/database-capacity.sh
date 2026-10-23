#!/bin/sh
# Wake the database, or let it sleep again. The deployed database is Aurora Serverless v2, which at a
# minimum capacity of 0 pauses when idle and costs nothing; the first request after a pause then waits
# for it to resume. When it is needed without that wait (a rehearsal, a load test, a demo), raise the
# minimum to 0.5 so it stays up; when done, let it sleep. Both are manual on purpose. It needs the AWS
# command line signed in to the right account, and changes only the one cluster named.
#
#   sh scripts/database-capacity.sh status --cluster <id> [--region <r>]
#   sh scripts/database-capacity.sh wake   --cluster <id> [--region <r>] [--max <acu>]
#   sh scripts/database-capacity.sh sleep  --cluster <id> [--region <r>] [--max <acu>] [--pause-after <secs>]
#
# The cluster may also be given as GRAFT_DB_CLUSTER. The maximum defaults to the cluster's own, so a
# wake never changes it. DRY_RUN=1 prints what would be run and changes nothing. A cluster left awake
# costs money by the hour: run `sleep` when done.
set -eu

usage() { echo "usage: database-capacity.sh <status|wake|sleep> --cluster <id> [--region <r>] [--max <acu>] [--pause-after <secs>]" >&2; exit 2; }
die() { echo "database-capacity: $*" >&2; exit 2; }

action=${1:-}
[ -n "$action" ] || usage
shift
cluster=${GRAFT_DB_CLUSTER:-}
region=""
max=""
pause_after=600
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) cluster=${2:-}; shift 2 ;;
    --region) region=${2:-}; shift 2 ;;
    --max) max=${2:-}; shift 2 ;;
    --pause-after) pause_after=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
case "$action" in status|wake|sleep) ;; *) usage ;; esac
[ -n "$cluster" ] || die "name the cluster with --cluster (or GRAFT_DB_CLUSTER)"

number() { printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; }
if [ -n "$max" ]; then
  number "$max" || die "--max must be a number of capacity units"
  # Aurora Serverless v2 accepts a minimum of 0.5 to keep it up and a maximum of at least that.
  awk -v m="$max" 'BEGIN { exit !(m >= 0.5) }' || die "--max must be at least 0.5"
fi
number "$pause_after" || die "--pause-after must be a number of seconds"
# Aurora allows an auto-pause delay of five minutes to a day.
if [ "$pause_after" -lt 300 ] || [ "$pause_after" -gt 86400 ]; then die "--pause-after must be between 300 and 86400 seconds"; fi

region_args=""
[ -z "$region" ] || region_args="--region $region"
# shellcheck disable=SC2086
rds() { aws rds "$@" $region_args; }
query() { rds describe-db-clusters --db-cluster-identifier "$cluster" --query "$1" --output text; }

show() {
  echo "cluster:  $cluster"
  echo "status:   $(query 'DBClusters[0].Status')"
  echo "minimum capacity: $(query 'DBClusters[0].ServerlessV2ScalingConfiguration.MinCapacity') units (0 means it pauses when idle)"
  echo "maximum capacity: $(query 'DBClusters[0].ServerlessV2ScalingConfiguration.MaxCapacity') units"
}

if [ "$action" = status ]; then show; exit 0; fi

[ -n "$max" ] || max=$(query 'DBClusters[0].ServerlessV2ScalingConfiguration.MaxCapacity')
number "$max" || die "could not read the cluster's maximum capacity (got '$max'): pass --max"

if [ "$action" = wake ]; then scaling="MinCapacity=0.5,MaxCapacity=$max"; else scaling="MinCapacity=0,MaxCapacity=$max,SecondsUntilAutoPause=$pause_after"; fi
if [ -n "${DRY_RUN:-}" ]; then
  echo "would run: aws rds modify-db-cluster --db-cluster-identifier $cluster --serverless-v2-scaling-configuration $scaling --apply-immediately $region_args"
  exit 0
fi
rds modify-db-cluster --db-cluster-identifier "$cluster" --serverless-v2-scaling-configuration "$scaling" --apply-immediately >/dev/null

if [ "$action" = wake ]; then
  echo "waiting for the cluster to be available (a paused one can take about a minute)..."
  for _ in $(seq 1 60); do
    [ "$(query 'DBClusters[0].Status')" = available ] && break
    sleep 5
  done
  show
  echo "it now stays up. Run 'sleep' when you are done, or it keeps costing money."
else
  show
  echo "it will pause after $pause_after seconds without connections."
fi
