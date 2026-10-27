#!/bin/sh
# The dev deployment on AWS, one phase at a time, each safe to run again. It creates only things named
# graft-dev-* (secrets under graft-dev/), tagged Project=graft Env=dev ManagedBy=claude-cli, in
# ap-south-1, in a VPC of its own. Nothing here names an account: the settings file (never committed)
# holds the profile, the region, the expected account, the role name and the ledger path.
#
#   sh scripts/aws-dev.sh <phase> [options]            DRY_RUN=1 reads, prints the plan, changes nothing
#
#   network                    the VPC: two public subnets, two private, no NAT gateway (it bills by the hour)
#   registry                   the image repository (immutable tags, keeps the last 5 images)
#   storage                    the audio bucket (private, in Mumbai); `cors --origin <site>` sets its CORS
#   roles                      the task, execution and infrastructure roles
#   logs                       the log group, seven days
#   push --local <image>       push a locally built image to the repository
#   database                   Aurora Serverless v2, at most 1 unit, may pause; writes the URL secret
#   secrets                    the operator secret
#   release --image <ref> --origin <site>
#                              run the release task once: migrate, seed, check the seeded chain
#   service --image <ref> --origin <site>
#                              the public service (ECS Express Mode): one small task behind /ready
#   redeploy --image <ref>     update the running service to a new image (only the image changes); rolls back
#                              to the previous revision if the new one never becomes ready
#   park | unpark              stop the service's task so the database can pause (the load balancer stays and
#                              still bills), or bring the one task back
#   load-up --image <ref> --origin <site>
#                              a clean copy for the load test: second database, second service, own blob prefix
#   load-down --yes            remove only that copy
#   status                     read-only sweep for anything that bills or was left behind
#   teardown --yes             delete everything above, in order; never touches the GitHub sign-in provider
#
# Every change is appended to the ledger with its time, the resource and a cost note.
set -eu

die() { echo "aws-dev: $*" >&2; exit 2; }
usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

PREFIX=graft-dev
CIDR=10.42.0.0/16
PUB_A_CIDR=10.42.0.0/24; PUB_B_CIDR=10.42.1.0/24; PRIV_A_CIDR=10.42.10.0/24; PRIV_B_CIDR=10.42.11.0/24
ENGINE_VERSION=16.15
# Graviton: native to the builder's machine, so the image builds without emulation, and cheaper on Fargate.
ARCH=ARM64
MAX_ACU=1
LOG_GROUP=/$PREFIX/service
TAGS_KV="Key=Project,Value=graft Key=Env,Value=dev Key=ManagedBy,Value=claude-cli"
# What differs between the live service and the load copy; the defaults are the live service's.
SVC=$PREFIX; DB_SECRET=database-url; BLOB_PREFIX=audio/; REL_FAMILY=$PREFIX-release; SVC_FAMILY=$PREFIX-service; EXTRA_ENV=""
# The load copy lifts the per-address limits (one client address would only measure the limiter) and
# says so; everything else is as deployed. It has its own database, secret, service and blob prefix.
use_load_stack() {
  SVC=$PREFIX-load; DB_SECRET=load-database-url; BLOB_PREFIX=audio/load/; REL_FAMILY=$PREFIX-release-load; SVC_FAMILY=$PREFIX-service-load
  EXTRA_ENV=',{"name":"GRAFT_PUBLISH_PER_IP","value":"1000000"},{"name":"GRAFT_REPORT_PER_IP","value":"1000000"},{"name":"GRAFT_INGEST_PER_IP","value":"1000000"},{"name":"GRAFT_GLOBAL_PUBLISH_PER_HOUR","value":"1000000"},{"name":"GRAFT_GLOBAL_PUBLISH_BURST","value":"100000"},{"name":"GRAFT_STORAGE_LIMIT_BYTES","value":"900000000000000"},{"name":"GRAFT_MAX_FORKS_PER_STAGE_PER_HOUR","value":"1000000"}'
}
tmp_files=""
cleanup() { for f in $tmp_files; do rm -f "$f"; done; }
trap cleanup EXIT INT TERM

phase=${1:-}
[ -n "$phase" ] || usage
shift

# ---- settings and the guard -----------------------------------------------------------------------
settings=${GRAFT_DEV_ENV:-.aws-dev.env}
[ -f "$settings" ] || die "no settings file at $settings (profile, region, account, role, ledger path; never committed)"
# shellcheck disable=SC1090
. "$settings"
for v in GRAFT_AWS_PROFILE GRAFT_AWS_REGION GRAFT_AWS_ACCOUNT_ID GRAFT_AWS_ROLE_NAME GRAFT_DEPLOY_LEDGER; do
  eval "[ -n \"\${$v:-}\" ]" || die "$v is not set in $settings"
done
[ "$GRAFT_AWS_REGION" = ap-south-1 ] || die "this only works in ap-south-1 (the settings say $GRAFT_AWS_REGION)"
REGION=$GRAFT_AWS_REGION
ACCOUNT=$GRAFT_AWS_ACCOUNT_ID

aws() { command aws --profile "$GRAFT_AWS_PROFILE" --region "$REGION" "$@"; }

guard() {
  identity=$(aws sts get-caller-identity --query '[Account,Arn]' --output text) || die "cannot tell who I am: sign in first"
  # shellcheck disable=SC2086
  set -- $identity
  [ "${1:-}" = "$ACCOUNT" ] || die "wrong account: signed in to ${1:-nothing}, expected the one in the settings"
  case "${2:-}" in
    *":assumed-role/$GRAFT_AWS_ROLE_NAME/"*) ;;
    *) die "must act as the role $GRAFT_AWS_ROLE_NAME, not ${2:-nothing}" ;;
  esac
}

# ---- helpers --------------------------------------------------------------------------------------
cost=""
ledger_row() { # description, result
  res=$(printf '%s' "$2" | tr '\n\t' '  ' | cut -c1-100)
  printf '| %s | %s | %s | %s |\n' "$(date -u '+%Y-%m-%d %H:%M')" "$1" "$res" "${cost:-none}" >> "$GRAFT_DEPLOY_LEDGER"
}

# A change: planned under DRY_RUN, otherwise run and written to the ledger. Prints the result.
mut() {
  desc=$1; shift
  if [ -n "${DRY_RUN:-}" ]; then
    echo "would run: aws $*" >&2
    for a in "$@"; do
      case "$a" in file://*) sed 's/^/    | /' "${a#file://}" >&2 ;; esac
    done
    echo "dry-$(printf '%s' "$desc" | cksum | cut -d' ' -f1)"
    return 0
  fi
  out=$(aws "$@") || { echo "aws-dev: failed: $desc" >&2; return 1; }
  ledger_row "$desc" "$out"
  echo "  done: $desc" >&2
  printf '%s\n' "$out"
}
# The same, for a delete that may find nothing to delete.
soft() { mut "$@" || echo "  (ignored: probably already gone)" >&2; }

lookup() { v=$(aws "$@" --output text) || return 1; [ "$v" = None ] && v=""; printf '%s' "$v"; }
# For calls that fail when the thing is absent (the failure is the answer).
probe() { v=$(aws "$@" --output text 2>/dev/null) || v=""; [ "$v" = None ] && v=""; printf '%s' "$v"; }

ts() { printf 'ResourceType=%s,Tags=[{Key=Name,Value=%s},{Key=Project,Value=graft},{Key=Env,Value=dev},{Key=ManagedBy,Value=claude-cli}]' "$1" "$2"; }
mktmp() { f=$(mktemp "${TMPDIR:-/tmp}/graft-aws.XXXXXX"); tmp_files="$tmp_files $f"; printf '%s' "$f"; }
wait_gone() { # a command that prints something while the thing exists
  [ -z "${DRY_RUN:-}" ] || return 0
  n=0
  while [ -n "$("$@" 2>/dev/null || true)" ] && [ "$n" -lt 90 ]; do sleep 10; n=$((n + 1)); done
}
opt() { # --name value pairs for the remaining arguments
  want=$1; shift
  while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { printf '%s' "${2:-}"; return 0; }; shift; done
  return 0
}

vpc_id() { lookup ec2 describe-vpcs --filters "Name=tag:Name,Values=$PREFIX-vpc" --query 'Vpcs[0].VpcId'; }
subnet_id() { lookup ec2 describe-subnets --filters "Name=tag:Name,Values=$PREFIX-$1" --query 'Subnets[0].SubnetId'; }
sg_id() { lookup ec2 describe-security-groups --filters "Name=group-name,Values=$PREFIX-$1" --query 'SecurityGroups[0].GroupId'; }
bucket_name() { lookup s3api list-buckets --query "Buckets[?starts_with(Name,'$PREFIX-audio-')].Name | [0]"; }
secret_arn() { probe secretsmanager describe-secret --secret-id "$PREFIX/$1" --query ARN; }
role_arn() { printf 'arn:aws:iam::%s:role/%s-%s' "$ACCOUNT" "$PREFIX" "$1"; }

# ---- network --------------------------------------------------------------------------------------
ensure_subnet() { # name cidr az
  id=$(subnet_id "$1")
  [ -n "$id" ] || id=$(mut "create subnet $PREFIX-$1 ($2, $3)" ec2 create-subnet --vpc-id "$vpc" --cidr-block "$2" \
    --availability-zone "$3" --tag-specifications "$(ts subnet "$PREFIX-$1")" --query Subnet.SubnetId --output text)
  printf '%s' "$id"
}
ensure_association() { # route table, subnet
  have=$(lookup ec2 describe-route-tables --route-table-ids "$1" --query "RouteTables[0].Associations[?SubnetId=='$2'].RouteTableAssociationId | [0]" 2>/dev/null || true)
  [ -n "$have" ] || mut "associate $2 with $1" ec2 associate-route-table --route-table-id "$1" --subnet-id "$2" --query AssociationId --output text >/dev/null
}

phase_network() {
  cost="free (VPC, subnets, route tables, security groups, S3 gateway endpoint; no NAT gateway, no interface endpoints)"
  vpc=$(vpc_id)
  if [ -z "$vpc" ]; then
    vpc=$(mut "create VPC $PREFIX-vpc ($CIDR)" ec2 create-vpc --cidr-block "$CIDR" --tag-specifications "$(ts vpc "$PREFIX-vpc")" --query Vpc.VpcId --output text)
    mut "enable DNS hostnames on $vpc" ec2 modify-vpc-attribute --vpc-id "$vpc" --enable-dns-hostnames >/dev/null
  fi
  igw=$(lookup ec2 describe-internet-gateways --filters "Name=tag:Name,Values=$PREFIX-igw" --query 'InternetGateways[0].InternetGatewayId')
  if [ -z "$igw" ]; then
    igw=$(mut "create internet gateway $PREFIX-igw" ec2 create-internet-gateway --tag-specifications "$(ts internet-gateway "$PREFIX-igw")" --query InternetGateway.InternetGatewayId --output text)
    mut "attach $igw to $vpc" ec2 attach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$vpc" >/dev/null
  fi
  pub_a=$(ensure_subnet public-a "$PUB_A_CIDR" ap-south-1a)
  pub_b=$(ensure_subnet public-b "$PUB_B_CIDR" ap-south-1b)
  priv_a=$(ensure_subnet private-a "$PRIV_A_CIDR" ap-south-1a)
  priv_b=$(ensure_subnet private-b "$PRIV_B_CIDR" ap-south-1b)

  pub_rt=$(lookup ec2 describe-route-tables --filters "Name=tag:Name,Values=$PREFIX-public" --query 'RouteTables[0].RouteTableId')
  if [ -z "$pub_rt" ]; then
    pub_rt=$(mut "create public route table" ec2 create-route-table --vpc-id "$vpc" --tag-specifications "$(ts route-table "$PREFIX-public")" --query RouteTable.RouteTableId --output text)
    mut "route the public table to the internet gateway" ec2 create-route --route-table-id "$pub_rt" --destination-cidr-block 0.0.0.0/0 --gateway-id "$igw" >/dev/null
  fi
  priv_rt=$(lookup ec2 describe-route-tables --filters "Name=tag:Name,Values=$PREFIX-private" --query 'RouteTables[0].RouteTableId')
  [ -n "$priv_rt" ] || priv_rt=$(mut "create private route table (no route out)" ec2 create-route-table --vpc-id "$vpc" --tag-specifications "$(ts route-table "$PREFIX-private")" --query RouteTable.RouteTableId --output text)
  ensure_association "$pub_rt" "$pub_a"; ensure_association "$pub_rt" "$pub_b"
  ensure_association "$priv_rt" "$priv_a"; ensure_association "$priv_rt" "$priv_b"

  ep=$(lookup ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$vpc" "Name=service-name,Values=com.amazonaws.ap-south-1.s3" --query 'VpcEndpoints[0].VpcEndpointId')
  [ -n "$ep" ] || mut "S3 gateway endpoint (free)" ec2 create-vpc-endpoint --vpc-id "$vpc" --service-name com.amazonaws.ap-south-1.s3 \
    --vpc-endpoint-type Gateway --route-table-ids "$pub_rt" --tag-specifications "$(ts vpc-endpoint "$PREFIX-s3")" --query VpcEndpoint.VpcEndpointId --output text >/dev/null

  db_sg=$(sg_id db)
  if [ -z "$db_sg" ]; then
    db_sg=$(mut "create security group $PREFIX-db" ec2 create-security-group --group-name "$PREFIX-db" --description "graft dev database" --vpc-id "$vpc" \
      --tag-specifications "$(ts security-group "$PREFIX-db")" --query GroupId --output text)
    mut "database accepts 5432 only from the public subnets (the service and release tasks)" ec2 authorize-security-group-ingress --group-id "$db_sg" \
      --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$PUB_A_CIDR},{CidrIp=$PUB_B_CIDR}]" >/dev/null
  fi
  rel_sg=$(sg_id release)
  [ -n "$rel_sg" ] || mut "create security group $PREFIX-release (no ingress)" ec2 create-security-group --group-name "$PREFIX-release" --description "graft dev release task" \
    --vpc-id "$vpc" --tag-specifications "$(ts security-group "$PREFIX-release")" --query GroupId --output text >/dev/null
  echo "network ready: $vpc" >&2
}

# ---- registry -------------------------------------------------------------------------------------
phase_registry() {
  cost="pennies (storage only; the lifecycle rule keeps 5 images)"
  have=$(probe ecr describe-repositories --repository-names "$PREFIX-service" --query 'repositories[0].repositoryName')
  [ -n "$have" ] || mut "create image repository $PREFIX-service" ecr create-repository --repository-name "$PREFIX-service" \
    --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 \
    --tags $TAGS_KV --query repository.repositoryArn --output text >/dev/null
  policy=$(mktmp)
  cat > "$policy" <<'EOF'
{"rules":[{"rulePriority":1,"description":"keep the last 5 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}
EOF
  mut "keep only the last 5 images" ecr put-lifecycle-policy --repository-name "$PREFIX-service" --lifecycle-policy-text "file://$policy" --query repositoryName --output text >/dev/null
}

# ---- storage --------------------------------------------------------------------------------------
phase_storage() {
  cost="pennies (audio is small; no versioning)"
  b=$(bucket_name)
  if [ -z "$b" ]; then
    b="$PREFIX-audio-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
    mut "create bucket $b in ap-south-1" s3api create-bucket --bucket "$b" --create-bucket-configuration LocationConstraint=ap-south-1 --query Location --output text >/dev/null
  fi
  mut "block all public access on $b" s3api put-public-access-block --bucket "$b" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  mut "encrypt $b with the S3-managed key" s3api put-bucket-encryption --bucket "$b" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  rules=$(mktmp)
  cat > "$rules" <<'EOF'
{"Rules":[{"ID":"abort-half-finished-uploads","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}
EOF
  mut "abort half-finished uploads after a day" s3api put-bucket-lifecycle-configuration --bucket "$b" --lifecycle-configuration "file://$rules"
  mut "tag $b" s3api put-bucket-tagging --bucket "$b" --tagging 'TagSet=[{Key=Project,Value=graft},{Key=Env,Value=dev},{Key=ManagedBy,Value=claude-cli}]'
  echo "bucket: $b" >&2
}

phase_cors() {
  origin=$(opt --origin "$@")
  [ -n "$origin" ] || die "cors needs --origin https://the-site"
  b=$(bucket_name); [ -n "$b" ] || die "no bucket yet: run storage first"
  cost="none"
  conf=$(mktmp)
  printf '{"CORSRules":[{"AllowedOrigins":["%s"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]}\n' "$origin" > "$conf"
  mut "allow GET from $origin on $b" s3api put-bucket-cors --bucket "$b" --cors-configuration "file://$conf"
}

# ---- roles ----------------------------------------------------------------------------------------
trust_doc() { # service principal
  f=$(mktmp)
  printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"%s"},"Action":"sts:AssumeRole"}]}\n' "$1" > "$f"
  printf '%s' "$f"
}
ensure_role() { # short name, principal
  have=$(probe iam get-role --role-name "$PREFIX-$1" --query Role.Arn)
  if [ -z "$have" ]; then
    mut "create role $PREFIX-$1" iam create-role --role-name "$PREFIX-$1" --assume-role-policy-document "file://$(trust_doc "$2")" \
      --description "graft dev" --tags $TAGS_KV --query Role.Arn --output text >/dev/null
    [ -n "${DRY_RUN:-}" ] || sleep 8
  fi
}

phase_roles() {
  cost="free"
  b=$(bucket_name); [ -n "$b" ] || [ -n "${DRY_RUN:-}" ] || die "run storage first (the task role is scoped to the bucket)"
  b=${b:-$PREFIX-audio-PLANNED}
  ensure_role task ecs-tasks.amazonaws.com
  pol=$(mktmp)
  cat > "$pol" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":"arn:aws:s3:::$b/audio/*"},
 {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::$b","Condition":{"StringLike":{"s3:prefix":["audio/*"]}}}]}
EOF
  mut "the task role reads and writes only audio/ in $b" iam put-role-policy --role-name "$PREFIX-task" --policy-name "$PREFIX-task-audio" --policy-document "file://$pol"

  ensure_role exec ecs-tasks.amazonaws.com
  mut "execution role: the standard ECS policy" iam attach-role-policy --role-name "$PREFIX-exec" --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  sec=$(mktmp)
  cat > "$sec" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:$PREFIX/*"}]}
EOF
  mut "execution role reads only the $PREFIX/ secrets" iam put-role-policy --role-name "$PREFIX-exec" --policy-name "$PREFIX-exec-secrets" --policy-document "file://$sec"

  ensure_role infra ecs.amazonaws.com
  mut "infrastructure role: the Express Mode policy" iam attach-role-policy --role-name "$PREFIX-infra" --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
}

# ---- logs -----------------------------------------------------------------------------------------
phase_logs() {
  cost="pennies (7 days of retention)"
  have=$(lookup logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query 'logGroups[0].logGroupName')
  [ -n "$have" ] || mut "create log group $LOG_GROUP" logs create-log-group --log-group-name "$LOG_GROUP" --tags Project=graft,Env=dev,ManagedBy=claude-cli
  mut "keep logs 7 days" logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 7
}

# ---- push -----------------------------------------------------------------------------------------
phase_push() {
  local_image=$(opt --local "$@")
  [ -n "$local_image" ] || die "push needs --local <image>"
  tag=$(opt --tag "$@"); [ -n "$tag" ] || tag="dev-$(git rev-parse --short HEAD)"
  registry="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
  ref="$registry/$PREFIX-service:$tag"
  cost="pennies"
  if [ -n "${DRY_RUN:-}" ]; then
    echo "would run: docker login (ecr) && docker tag $local_image <registry>/$PREFIX-service:$tag && docker push" >&2
    return 0
  fi
  aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
  docker tag "$local_image" "$ref"
  docker push "$ref" >/dev/null
  ledger_row "push image $PREFIX-service:$tag" "$(aws ecr describe-images --repository-name "$PREFIX-service" --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text)"
  echo "$ref"
}

# ---- database -------------------------------------------------------------------------------------
phase_database() {
  cost="Aurora Serverless v2: at most $MAX_ACU unit. Pauses only if nothing holds a connection (measured: about 16 minutes after the task stops); the service does hold one, so expect about 0.5 unit all day (roughly 2 USD a day) until parked. Unverified estimate."
  priv_a=$(subnet_id private-a); priv_b=$(subnet_id private-b); db_sg=$(sg_id db)
  if [ -z "${DRY_RUN:-}" ]; then
    [ -n "$priv_a" ] && [ -n "$priv_b" ] && [ -n "$db_sg" ] || die "run network first"
  fi
  grp=$(probe rds describe-db-subnet-groups --db-subnet-group-name "$PREFIX-db" --query 'DBSubnetGroups[0].DBSubnetGroupName')
  [ -n "$grp" ] || mut "create database subnet group (private subnets)" rds create-db-subnet-group --db-subnet-group-name "$PREFIX-db" \
    --db-subnet-group-description "graft dev" --subnet-ids "$priv_a" "$priv_b" --tags $TAGS_KV --query DBSubnetGroup.DBSubnetGroupName --output text >/dev/null

  have=$(probe rds describe-db-clusters --db-cluster-identifier "$PREFIX-db" --query 'DBClusters[0].DBClusterIdentifier')
  if [ -z "$have" ]; then
    if [ -n "${DRY_RUN:-}" ]; then pw='<generated>'; else pw=$(aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --query RandomPassword --output text); fi
    conf=$(mktmp); chmod 600 "$conf"
    cat > "$conf" <<EOF
{
  "DBClusterIdentifier": "$PREFIX-db",
  "Engine": "aurora-postgresql",
  "EngineVersion": "$ENGINE_VERSION",
  "MasterUsername": "graft",
  "MasterUserPassword": "$pw",
  "DatabaseName": "graft",
  "DBSubnetGroupName": "$PREFIX-db",
  "VpcSecurityGroupIds": ["$db_sg"],
  "BackupRetentionPeriod": 1,
  "StorageEncrypted": true,
  "DeletionProtection": false,
  "CopyTagsToSnapshot": true,
  "ServerlessV2ScalingConfiguration": {"MinCapacity": 0, "MaxCapacity": $MAX_ACU, "SecondsUntilAutoPause": 300},
  "Tags": [{"Key":"Project","Value":"graft"},{"Key":"Env","Value":"dev"},{"Key":"ManagedBy","Value":"claude-cli"}]
}
EOF
    mut "create Aurora cluster $PREFIX-db (min 0, max $MAX_ACU units, 1 day of backups)" rds create-db-cluster --cli-input-json "file://$conf" --query DBCluster.DBClusterArn --output text >/dev/null
    inst=$(probe rds describe-db-instances --db-instance-identifier "$PREFIX-db-1" --query 'DBInstances[0].DBInstanceIdentifier')
    [ -n "$inst" ] || mut "create the serverless writer $PREFIX-db-1" rds create-db-instance --db-instance-identifier "$PREFIX-db-1" --db-cluster-identifier "$PREFIX-db" \
      --engine aurora-postgresql --db-instance-class db.serverless --no-publicly-accessible --monitoring-interval 0 --no-enable-performance-insights \
      --tags $TAGS_KV --query DBInstance.DBInstanceIdentifier --output text >/dev/null
    if [ -z "${DRY_RUN:-}" ]; then echo "waiting for the database (about 10 minutes)..." >&2; aws rds wait db-instance-available --db-instance-identifier "$PREFIX-db-1"; fi
    store_database_url "$pw"
  else
    echo "the database already exists: $have" >&2
    # An earlier run may have stopped after the cluster was made and before its secret was stored; the
    # password it generated went with its temporary file, so the cluster gets a new one, stored now.
    if [ -z "$(secret_arn database-url)" ]; then
      echo "its URL secret is missing: giving the cluster a new master password and storing it" >&2
      if [ -n "${DRY_RUN:-}" ]; then pw='<generated>'; else pw=$(aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --query RandomPassword --output text); fi
      conf=$(mktmp); chmod 600 "$conf"
      cat > "$conf" <<EOF
{
  "DBClusterIdentifier": "$PREFIX-db",
  "MasterUserPassword": "$pw",
  "ApplyImmediately": true
}
EOF
      mut "reset the master password of $PREFIX-db (the earlier one was never stored)" rds modify-db-cluster --cli-input-json "file://$conf" --query DBCluster.DBClusterIdentifier --output text >/dev/null
      if [ -z "${DRY_RUN:-}" ]; then aws rds wait db-instance-available --db-instance-identifier "$PREFIX-db-1"; fi
      store_database_url "$pw"
    fi
  fi
}
# The URL carries the password, so it goes into the secret from a private temporary file and is never printed.
store_database_url() {
  if [ -n "${DRY_RUN:-}" ]; then host='<endpoint>'; else host=$(aws rds describe-db-clusters --db-cluster-identifier "$PREFIX-db" --query 'DBClusters[0].Endpoint' --output text); fi
  url=$(mktmp); chmod 600 "$url"
  printf 'postgres://graft:%s@%s:5432/graft?sslmode=require' "$1" "$host" > "$url"
  mut "store the database URL as secret $PREFIX/database-url (value never printed)" secretsmanager create-secret --name "$PREFIX/database-url" \
    --secret-string "file://$url" --tags $TAGS_KV --query ARN --output text >/dev/null
}

phase_secrets() {
  cost="a secret costs about 0.40 USD a month"
  if [ -n "$(secret_arn admin-secret)" ]; then echo "the operator secret already exists" >&2; return 0; fi
  if [ -n "${DRY_RUN:-}" ]; then pw='<generated>'; else pw=$(aws secretsmanager get-random-password --password-length 48 --exclude-punctuation --query RandomPassword --output text); fi
  f=$(mktmp); chmod 600 "$f"; printf '%s' "$pw" > "$f"
  mut "store the operator secret as $PREFIX/admin-secret (value never printed)" secretsmanager create-secret --name "$PREFIX/admin-secret" \
    --secret-string "file://$f" --tags $TAGS_KV --query ARN --output text >/dev/null
}

# ---- shared by the release task and the service ---------------------------------------------------
container_env() { # origin
  b=$(bucket_name); b=${b:-$PREFIX-audio-PLANNED}
  printf '[{"name":"GRAFT_ENVIRONMENT","value":"dev"},{"name":"GRAFT_BLOB_S3_BUCKET","value":"%s"},{"name":"GRAFT_BLOB_S3_REGION","value":"%s"},{"name":"GRAFT_BLOB_S3_PREFIX","value":"%s"},{"name":"GRAFT_TRUSTED_PROXY_HOPS","value":"1"},{"name":"GRAFT_CORS_ORIGINS","value":"%s"},{"name":"GRAFT_DB_STARTUP_WAIT_SECS","value":"60"}%s]' "$b" "$REGION" "$BLOB_PREFIX" "$1" "$EXTRA_ENV"
}
container_secrets() {
  db=$(secret_arn "$DB_SECRET"); ad=$(secret_arn admin-secret)
  printf '[{"name":"GRAFT_DATABASE_URL","valueFrom":"%s"},{"name":"GRAFT_ADMIN_SECRET","valueFrom":"%s"}]' "${db:-<$DB_SECRET-arn>}" "${ad:-<admin-secret-arn>}"
}
ensure_cluster() {
  have=$(probe ecs describe-clusters --clusters "$PREFIX" --query "clusters[?status=='ACTIVE'].clusterName | [0]")
  [ -n "$have" ] || mut "create ECS cluster $PREFIX (container insights off: it bills per metric)" ecs create-cluster --cluster-name "$PREFIX" \
    --settings name=containerInsights,value=disabled --tags key=Project,value=graft key=Env,value=dev key=ManagedBy,value=claude-cli --query cluster.clusterArn --output text >/dev/null
}

phase_release() {
  image=$(opt --image "$@"); origin=$(opt --origin "$@")
  [ -n "$image" ] && [ -n "$origin" ] || die "release needs --image <ref> and --origin <site origin>"
  cost="a Fargate task for a minute or two"
  ensure_cluster
  def=$(mktmp)
  cat > "$def" <<EOF
{"family":"$REL_FAMILY","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"cpu":"512","memory":"1024",
 "executionRoleArn":"$(role_arn exec)","taskRoleArn":"$(role_arn task)",
 "runtimePlatform":{"cpuArchitecture":"$ARCH","operatingSystemFamily":"LINUX"},
 "containerDefinitions":[{"name":"graft","image":"$image","essential":true,
  "command":["graft-seed-chain","--manifest","seed/chain.json","--check-snapshot","web"],
  "environment":$(container_env "$origin"),"secrets":$(container_secrets),
  "logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"$LOG_GROUP","awslogs-region":"$REGION","awslogs-stream-prefix":"release"}}}],
 "tags":[{"key":"Project","value":"graft"},{"key":"Env","value":"dev"},{"key":"ManagedBy","value":"claude-cli"}]}
EOF
  td=$(mut "register the release task definition" ecs register-task-definition --cli-input-json "file://$def" --query taskDefinition.taskDefinitionArn --output text)
  pub_a=$(subnet_id public-a); rel_sg=$(sg_id release)
  task=$(mut "run the release task once (migrate, seed, check the snapshot)" ecs run-task --cluster "$PREFIX" --launch-type FARGATE --task-definition "$td" \
    --network-configuration "awsvpcConfiguration={subnets=[$pub_a],securityGroups=[$rel_sg],assignPublicIp=ENABLED}" --count 1 --query 'tasks[0].taskArn' --output text)
  [ -z "${DRY_RUN:-}" ] || return 0
  [ -n "$task" ] && [ "$task" != None ] || die "the release task did not start"
  echo "waiting for the release task to finish..." >&2
  aws ecs wait tasks-stopped --cluster "$PREFIX" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$PREFIX" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  reason=$(aws ecs describe-tasks --cluster "$PREFIX" --tasks "$task" --query 'tasks[0].stoppedReason' --output text)
  id=${task##*/}
  echo "release task exit code: $code ($reason)" >&2
  aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "release/graft/$id" --limit 40 --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' | tail -25 >&2 || true
  ledger_row "release task finished" "exit code $code"
  [ "$code" = 0 ] || die "the release task failed"
}

# ---- service --------------------------------------------------------------------------------------
phase_service() {
  image=$(opt --image "$@"); origin=$(opt --origin "$@")
  [ -n "$origin" ] || die "service needs --origin https://the-site (CORS must name it)"
  [ -n "$image" ] || die "service needs --image <ref>"
  # Creating is for the first time only: a service that exists is updated with `redeploy`.
  have=$(probe ecs describe-express-gateway-service --service-arn "arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$SVC" --query 'service.status.statusCode')
  case "$have" in
    ""|INACTIVE|DRAINING) ;; # absent, or deleted and still describable for a while
    *) die "the service $SVC already exists: use redeploy --image <ref> to update it" ;;
  esac
  cost="BILLS BY THE HOUR while up: an application load balancer (about 0.03 USD/h with its capacity units), 3 public IPv4 addresses (0.005 USD/h each), one 0.5 vCPU / 1 GB Fargate task (about 0.03 USD/h). Roughly 2 USD a day plus the database. Unverified estimate; run status, and teardown when idle."
  ensure_cluster
  pub_a=$(subnet_id public-a); pub_b=$(subnet_id public-b)
  def=$(mktmp)
  cat > "$def" <<EOF
{"family":"$SVC_FAMILY","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"cpu":"512","memory":"1024",
 "executionRoleArn":"$(role_arn exec)","taskRoleArn":"$(role_arn task)",
 "runtimePlatform":{"cpuArchitecture":"$ARCH","operatingSystemFamily":"LINUX"},
 "containerDefinitions":[{"name":"Main","image":"$image","essential":true,
  "portMappings":[{"containerPort":8080,"name":"http","protocol":"tcp"}],
  "environment":$(container_env "$origin"),"secrets":$(container_secrets),
  "logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"$LOG_GROUP","awslogs-region":"$REGION","awslogs-stream-prefix":"service"}}}],
 "tags":[{"key":"Project","value":"graft"},{"key":"Env","value":"dev"},{"key":"ManagedBy","value":"claude-cli"}]}
EOF
  td=$(mut "register the service task definition (ARM64, 0.5 vCPU, 1 GB)" ecs register-task-definition --cli-input-json "file://$def" --query taskDefinition.taskDefinitionArn --output text)
  mut "create the Express service $SVC: one task, /ready" ecs create-express-gateway-service --service-name "$SVC" --cluster "$PREFIX" \
    --infrastructure-role-arn "$(role_arn infra)" --task-definition-arn "$td" \
    --health-check-path /ready --scaling-target minTaskCount=1,maxTaskCount=1,autoScalingMetric=AVERAGE_CPU \
    --network-configuration "subnets=$pub_a,$pub_b" \
    --tags '[{"key":"Project","value":"graft"},{"key":"Env","value":"dev"},{"key":"ManagedBy","value":"claude-cli"}]' --output json >/dev/null
  [ -z "${DRY_RUN:-}" ] || return 0
  arn="arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$SVC"
  ledger_row "Express service resources (load balancer, target groups, security groups, scaling): record for teardown" \
    "$(aws ecs describe-express-gateway-service --service-arn "$arn" --output json 2>&1 | tr -d ' \n' | cut -c1-400)"
  echo "created. Watch it settle with: sh scripts/aws-dev.sh status" >&2
}

# ---- redeploy ---------------------------------------------------------------------------------------
# Update the running service to a new image: copy the running task definition with only its image
# replaced (so every setting stays as it is), point the Express service at it, wait for the roll to
# finish and for /ready, and put the previous revision back if that never happens. Express rolls
# blue/green, so two tasks run for ten minutes or more.
phase_redeploy() {
  image=$(opt --image "$@")
  [ -n "$image" ] || die "redeploy needs --image <ref>"
  cost="a second task runs while the roll finishes (ten to fifteen minutes), then one again"
  arn="arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$SVC"
  previous=$(lookup ecs describe-services --cluster "$PREFIX" --services "$SVC" --query "services[0].deployments[?status=='PRIMARY'].taskDefinition | [0]")
  def=$(mktmp)
  if [ -n "${DRY_RUN:-}" ]; then
    printf '{"note":"the running task definition, with its image replaced by %s"}\n' "$image" > "$def"
  else
    [ -n "$previous" ] || die "could not read the running task definition of $SVC"
    command -v jq >/dev/null || die "redeploy needs jq"
    aws ecs describe-task-definition --task-definition "$previous" --query taskDefinition \
      | jq --arg image "$image" '.containerDefinitions[0].image = $image
          | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' > "$def"
  fi
  td=$(mut "register the new task definition (only the image differs)" ecs register-task-definition --cli-input-json "file://$def" --query taskDefinition.taskDefinitionArn --output text)
  mut "point the service at the new revision" ecs update-express-gateway-service --service-arn "$arn" --task-definition-arn "$td" --output json >/dev/null
  if [ -n "${DRY_RUN:-}" ]; then
    echo "if it is not ready within 20 minutes it would be rolled back to ${previous:-the revision now running}" >&2
    return 0
  fi
  if wait_ready "$td"; then ledger_row "redeploy finished, ready" "$td"; echo "ready on the new revision." >&2; return 0; fi
  echo "aws-dev: the new revision did not become ready: rolling back" >&2
  mut "roll back to the previous revision" ecs update-express-gateway-service --service-arn "$arn" --task-definition-arn "$previous" --output json >/dev/null
  wait_ready "$previous" || echo "aws-dev: the rollback is also slow: run status and look at the service events" >&2
  die "the new revision did not become ready; the service was put back on $previous"
}
# Ready means: the revision asked for is the primary one, its roll is complete (the new task has taken
# over), and the service answers. The primary check matters: right after the update the old revision is
# still primary and complete, and would pass for the new one. It waits GRAFT_READY_WAIT_SECS (20 minutes)
# by the clock, polling every GRAFT_READY_POLL_SECS.
wait_ready() {
  want=$1
  endpoint=$(aws ecs describe-express-gateway-service --service-arn "arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$SVC" --query 'service.activeConfigurations[0].ingressPaths[0].endpoint' --output text)
  case "$endpoint" in http://*|https://*) ;; *) endpoint="https://$endpoint" ;; esac
  deadline=$(( $(date +%s) + ${GRAFT_READY_WAIT_SECS:-1200} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    primary=$(aws ecs describe-services --cluster "$PREFIX" --services "$SVC" --query "services[0].deployments[?status=='PRIMARY'].taskDefinition | [0]" --output text)
    state=$(aws ecs describe-services --cluster "$PREFIX" --services "$SVC" --query "services[0].deployments[?status=='PRIMARY'].rolloutState | [0]" --output text)
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$endpoint/ready" 2>/dev/null || true)
    [ "$primary" = "$want" ] && [ "$state" = COMPLETED ] && [ "$code" = 200 ] && return 0
    [ "$primary" = "$want" ] && [ "$state" = FAILED ] && return 1
    sleep "${GRAFT_READY_POLL_SECS:-10}"
  done
  return 1
}

# ---- park and unpark ------------------------------------------------------------------------------
# The database pauses only with no connection open, and the service keeps a pool and an event relay
# connected, so while a task runs the database stays at about half a unit. Parking stops the task;
# the address and the load balancer stay (the load balancer still bills by the hour).
scale_service() { # min max
  arn="arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$SVC"
  mut "set the service to $1..$2 tasks" ecs update-express-gateway-service --service-arn "$arn" \
    --scaling-target "minTaskCount=$1,maxTaskCount=$2,autoScalingMetric=AVERAGE_CPU,autoScalingTargetValue=60" --output json >/dev/null
}
phase_park() {
  cost="stops the task and lets the database pause about 16 minutes later (measured); the load balancer and its 2 public addresses still bill (about 1.3 USD a day, unverified)"
  scale_service 0 0
}
phase_unpark() {
  cost="one task and the database awake again (about 2 USD a day more, unverified)"
  scale_service 1 1
}

# ---- the load copy ---------------------------------------------------------------------------------
# The load test writes thousands of flips and audio files, and nothing can purge them, so it never runs
# against the live data. It runs against a copy of the same topology: a second database inside the same
# cluster, a second service from the same image, and its own blob prefix; then the copy is removed.
# A one-off task runs psql against the cluster, because the cluster is private and a laptop cannot.
psql_task() { # one SQL statement
  main=$(secret_arn database-url)
  def=$(mktmp)
  cat > "$def" <<EOF
{"family":"$PREFIX-loadsetup","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"cpu":"256","memory":"512",
 "executionRoleArn":"$(role_arn exec)","taskRoleArn":"$(role_arn task)",
 "runtimePlatform":{"cpuArchitecture":"$ARCH","operatingSystemFamily":"LINUX"},
 "containerDefinitions":[{"name":"psql","image":"public.ecr.aws/docker/library/postgres:16-alpine","essential":true,
  "command":["sh","-c","psql \"\$GRAFT_DATABASE_URL\" -v ON_ERROR_STOP=1 -c \"$1\""],
  "secrets":[{"name":"GRAFT_DATABASE_URL","valueFrom":"${main:-<database-url-arn>}"}],
  "logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"$LOG_GROUP","awslogs-region":"$REGION","awslogs-stream-prefix":"loadsetup"}}}],
 "tags":[{"key":"Project","value":"graft"},{"key":"Env","value":"dev"},{"key":"ManagedBy","value":"claude-cli"}]}
EOF
  td=$(mut "register the one-off psql task definition" ecs register-task-definition --cli-input-json "file://$def" --query taskDefinition.taskDefinitionArn --output text)
  pub_a=$(subnet_id public-a); rel_sg=$(sg_id release)
  task=$(mut "run psql once: $1" ecs run-task --cluster "$PREFIX" --launch-type FARGATE --task-definition "$td" \
    --network-configuration "awsvpcConfiguration={subnets=[$pub_a],securityGroups=[$rel_sg],assignPublicIp=ENABLED}" --count 1 --query 'tasks[0].taskArn' --output text)
  [ -z "${DRY_RUN:-}" ] || return 0
  [ -n "$task" ] && [ "$task" != None ] || die "the psql task did not start"
  aws ecs wait tasks-stopped --cluster "$PREFIX" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$PREFIX" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  logs=$(aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "loadsetup/psql/${task##*/}" --query 'events[].message' --output text 2>/dev/null || true)
  echo "psql: exit $code: $logs" >&2
  [ "$code" = 0 ] && return 0
  case "$logs" in *"already exists"*|*"does not exist"*) return 0 ;; esac
  die "psql failed: $logs"
}

phase_load_up() {
  image=$(opt --image "$@"); origin=$(opt --origin "$@")
  [ -n "$image" ] && [ -n "$origin" ] || die "load-up needs --image <ref> and --origin <site origin>"
  use_load_stack
  cost="A SECOND SERVICE: bills by the hour like the live one (about 2 USD a day while up) until load-down. The database is shared and idle."
  ensure_cluster
  psql_task "CREATE DATABASE graft_load"
  if [ -z "$(secret_arn "$DB_SECRET")" ]; then
    url=$(mktmp); chmod 600 "$url"
    if [ -n "${DRY_RUN:-}" ]; then printf 'postgres://graft:<generated>@<endpoint>:5432/graft_load?sslmode=require' > "$url"
    else aws secretsmanager get-secret-value --secret-id "$PREFIX/database-url" --query SecretString --output text | sed 's#/graft?#/graft_load?#' | tr -d '\n' > "$url"; fi
    mut "store the load database URL as secret $PREFIX/$DB_SECRET (value never printed)" secretsmanager create-secret --name "$PREFIX/$DB_SECRET" \
      --secret-string "file://$url" --tags $TAGS_KV --query ARN --output text >/dev/null
  fi
  phase_release "$@"
  phase_service "$@"
}

phase_load_down() {
  case " $* " in *" --yes "*) ;; *) die "load-down removes the load copy: pass --yes" ;; esac
  use_load_stack
  cost="stops the second service's hourly billing"
  soft "delete the load service" ecs delete-express-gateway-service --service-arn "arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$SVC"
  wait_gone probe ecs describe-services --cluster "$PREFIX" --services "$SVC" --query "services[?status!='INACTIVE'].serviceName | [0]"
  psql_task "DROP DATABASE IF EXISTS graft_load WITH (FORCE)"
  soft "delete the load secret now, not after a recovery window" secretsmanager delete-secret --secret-id "$PREFIX/$DB_SECRET" --force-delete-without-recovery --query Name --output text
  b=$(bucket_name || true)
  [ -z "$b" ] || soft "remove the load audio (only the audio/load/ prefix)" s3 rm "s3://$b/audio/load/" --recursive --quiet
  echo "the load copy is gone. Now run: sh scripts/aws-dev.sh status" >&2
}

# ---- status: read-only ----------------------------------------------------------------------------
phase_status() {
  warn=0
  flag() { echo "WARN  $*"; warn=$((warn + 1)); }
  echo "== what can bill by the hour (ap-south-1, read-only) =="
  nat=$(lookup ec2 describe-nat-gateways --filter Name=state,Values=pending,available --query 'NatGateways[].NatGatewayId' || true)
  [ -z "$nat" ] && echo "ok    no NAT gateway" || flag "NAT gateway exists: $nat (about 0.045 USD/h plus data)"
  # An allocated address attached to nothing bills just the same and is the usual leak; the addresses
  # of the load balancer's own interfaces are part of it and go when it goes.
  loose=$(lookup ec2 describe-addresses --query 'Addresses[?AssociationId==`null`].PublicIp' || true)
  [ -z "$loose" ] && echo "ok    no loose Elastic IP addresses" || flag "Elastic IPs attached to nothing: $loose (each bills while allocated)"
  inuse=$(lookup ec2 describe-network-interfaces --query 'length(NetworkInterfaces[?Association.PublicIp])' || true)
  echo "info  public IPv4 addresses in use: ${inuse:-0} (about 0.005 USD/h each)"
  lbs=$(lookup elbv2 describe-load-balancers --query 'LoadBalancers[].[LoadBalancerName,State.Code]' || true)
  [ -z "$lbs" ] && echo "ok    no load balancers" || echo "info  load balancers: $lbs (about 0.03 USD/h each)"
  names=$(lookup ecs list-services --cluster "$PREFIX" --query 'serviceArns[]' 2>/dev/null || true)
  if [ -z "$names" ]; then echo "ok    no service"; else
    # shellcheck disable=SC2086
    echo "info  services: $(lookup ecs describe-services --cluster "$PREFIX" --services $names --query 'services[].[serviceName,status,desiredCount,runningCount]' 2>/dev/null || true)"
    [ "$(echo "$names" | wc -w | tr -d ' ')" -le 1 ] || flag "more than one service is running: a load copy left up bills like the live service (load-down --yes)"
  fi
  tasks=$(lookup ecs list-tasks --cluster "$PREFIX" --query 'taskArns' 2>/dev/null || true)
  [ -z "$tasks" ] && echo "ok    no running tasks" || echo "info  running tasks: $(echo "$tasks" | wc -w | tr -d ' ')"
  db=$(lookup rds describe-db-clusters --query 'DBClusters[].[DBClusterIdentifier,Status,ServerlessV2ScalingConfiguration.MinCapacity,ServerlessV2ScalingConfiguration.MaxCapacity]' || true)
  [ -z "$db" ] && echo "ok    no database clusters" || echo "info  database: $db"
  inst=$(lookup rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceClass,DBInstanceStatus]' || true)
  [ -z "$inst" ] || echo "info  database instances: $inst"
  snaps=$(lookup rds describe-db-cluster-snapshots --snapshot-type manual --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier' || true)
  [ -z "$snaps" ] && echo "ok    no manual database snapshots" || flag "manual snapshots (bill for storage): $snaps"
  if [ -n "$db" ]; then
    acu=$(lookup cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity --dimensions "Name=DBClusterIdentifier,Value=$PREFIX-db" \
      --start-time "$(date -u -v-1H '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%S')" --end-time "$(date -u '+%Y-%m-%dT%H:%M:%S')" --period 300 --statistics Average --query 'Datapoints[].Average' 2>/dev/null || true)
    echo "info  database capacity, last hour (0 means paused): ${acu:-no datapoints}"
  fi
  ifaces=$(lookup ec2 describe-vpc-endpoints --filters Name=vpc-endpoint-type,Values=Interface --query 'VpcEndpoints[].VpcEndpointId' || true)
  [ -z "$ifaces" ] && echo "ok    no interface endpoints" || flag "interface endpoints (about 0.01 USD/h each per zone): $ifaces"
  vols=$(lookup ec2 describe-volumes --filters Name=status,Values=available --query 'Volumes[].VolumeId' || true)
  [ -z "$vols" ] && echo "ok    no detached volumes" || flag "detached volumes: $vols"
  noret=$(lookup logs describe-log-groups --query 'logGroups[?retentionInDays==`null`].logGroupName' || true)
  [ -z "$noret" ] && echo "ok    every log group has a retention period" || flag "log groups kept forever: $noret"
  imgs=$(lookup ecr describe-images --repository-name "$PREFIX-service" --query 'length(imageDetails)' 2>/dev/null || true)
  echo "info  images in the repository: ${imgs:-none}"
  b=$(bucket_name || true)
  [ -z "$b" ] || echo "info  bucket $b: $(aws s3 ls "s3://$b" --recursive --summarize 2>/dev/null | tail -2 | tr '\n' ' ')"
  secs=$(lookup secretsmanager list-secrets --query 'SecretList[].Name' || true)
  echo "info  secrets: ${secs:-none}"
  stray=$(lookup resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=graft --query 'ResourceTagMappingList[].ResourceARN' || true)
  echo "info  resources tagged Project=graft: $(echo "$stray" | wc -w | tr -d ' ')"
  [ "$warn" -eq 0 ] && echo "== nothing unexpected ==" || echo "== $warn warning(s) above =="
}

# ---- teardown -------------------------------------------------------------------------------------
# A security group cannot go while a network interface still holds it; the interfaces of a deleted
# service take a few minutes to release, so a real run retries.
delete_sg() {
  id=$(sg_id "$1" || true)
  [ -n "$id" ] || return 0
  if [ -n "${DRY_RUN:-}" ]; then soft "delete security group $PREFIX-$1" ec2 delete-security-group --group-id "$id"; return 0; fi
  n=0
  until aws ec2 delete-security-group --group-id "$id" 2>/dev/null; do
    n=$((n + 1))
    [ "$n" -lt 30 ] || { echo "aws-dev: security group $PREFIX-$1 is still in use after 5 minutes" >&2; return 1; }
    sleep 10
  done
  ledger_row "delete security group $PREFIX-$1" "$id"
}

phase_teardown() {
  case " $* " in *" --yes "*) ;; *) die "teardown deletes everything graft made in dev: pass --yes" ;; esac
  cost="stops all hourly billing"
  arn="arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$PREFIX"
  # The load copy first, if it was left up: it bills like the live service, and its network interfaces
  # would keep the security groups and the VPC from being deleted.
  soft "delete the load service, if it is there" ecs delete-express-gateway-service --service-arn "arn:aws:ecs:$REGION:$ACCOUNT:service/$PREFIX/$PREFIX-load"
  soft "delete the load secret, if it is there" secretsmanager delete-secret --secret-id "$PREFIX/load-database-url" --force-delete-without-recovery --query Name --output text
  soft "delete the Express service (and the load balancer, target groups and scaling it made)" ecs delete-express-gateway-service --service-arn "$arn"
  wait_gone probe ecs describe-services --cluster "$PREFIX" --services "$PREFIX" "$PREFIX-load" --query "services[?status!='INACTIVE'].serviceName | [0]"
  for t in $(lookup ecs list-tasks --cluster "$PREFIX" --query 'taskArns' 2>/dev/null || true); do soft "stop task $t" ecs stop-task --cluster "$PREFIX" --task "$t" --query 'task.taskArn' --output text; done
  soft "delete the ECS cluster" ecs delete-cluster --cluster "$PREFIX" --query cluster.clusterName --output text
  soft "delete the log group" logs delete-log-group --log-group-name "$LOG_GROUP"

  soft "delete the database writer" rds delete-db-instance --db-instance-identifier "$PREFIX-db-1" --skip-final-snapshot --delete-automated-backups --query DBInstance.DBInstanceIdentifier --output text
  wait_gone probe rds describe-db-instances --db-instance-identifier "$PREFIX-db-1" --query 'DBInstances[0].DBInstanceIdentifier'
  soft "delete the database cluster (no final snapshot)" rds delete-db-cluster --db-cluster-identifier "$PREFIX-db" --skip-final-snapshot --delete-automated-backups --query DBCluster.DBClusterIdentifier --output text
  wait_gone probe rds describe-db-clusters --db-cluster-identifier "$PREFIX-db" --query 'DBClusters[0].DBClusterIdentifier'
  soft "delete the database subnet group" rds delete-db-subnet-group --db-subnet-group-name "$PREFIX-db"

  for s in database-url admin-secret; do
    soft "delete secret $PREFIX/$s now, not after a recovery window" secretsmanager delete-secret --secret-id "$PREFIX/$s" --force-delete-without-recovery --query Name --output text
  done
  soft "delete the image repository and its images" ecr delete-repository --repository-name "$PREFIX-service" --force --query repository.repositoryName --output text
  b=$(bucket_name || true)
  if [ -n "$b" ]; then
    soft "empty bucket $b" s3 rm "s3://$b" --recursive --quiet
    soft "delete bucket $b" s3api delete-bucket --bucket "$b"
  fi

  for r in task exec infra github-deploy; do
    for p in $(probe iam list-attached-role-policies --role-name "$PREFIX-$r" --query 'AttachedPolicies[].PolicyArn'); do soft "detach $p from $PREFIX-$r" iam detach-role-policy --role-name "$PREFIX-$r" --policy-arn "$p"; done
    for p in $(probe iam list-role-policies --role-name "$PREFIX-$r" --query 'PolicyNames'); do soft "delete inline policy $p of $PREFIX-$r" iam delete-role-policy --role-name "$PREFIX-$r" --policy-name "$p"; done
    soft "delete role $PREFIX-$r" iam delete-role --role-name "$PREFIX-$r"
  done
  echo "skip: the GitHub sign-in provider in this account belongs to another project and is left alone" >&2

  vpc=$(vpc_id || true)
  if [ -n "$vpc" ]; then
    for e in $(lookup ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$vpc" --query 'VpcEndpoints[].VpcEndpointId'); do soft "delete endpoint $e" ec2 delete-vpc-endpoints --vpc-endpoint-ids "$e" --query Unsuccessful --output text; done
    for g in db release; do delete_sg "$g"; done
    for sn in $(lookup ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" --query 'Subnets[].SubnetId'); do soft "delete subnet $sn" ec2 delete-subnet --subnet-id "$sn"; done
    for rt in $(lookup ec2 describe-route-tables --filters "Name=vpc-id,Values=$vpc" "Name=tag:Project,Values=graft" --query 'RouteTables[].RouteTableId'); do soft "delete route table $rt" ec2 delete-route-table --route-table-id "$rt"; done
    igw=$(lookup ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$vpc" --query 'InternetGateways[0].InternetGatewayId' || true)
    if [ -n "$igw" ]; then
      soft "detach internet gateway" ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$vpc"
      soft "delete internet gateway" ec2 delete-internet-gateway --internet-gateway-id "$igw"
    fi
    soft "delete the VPC" ec2 delete-vpc --vpc-id "$vpc"
  fi
  echo "teardown done. Now run: sh scripts/aws-dev.sh status" >&2
}

case "$phase" in
  network|registry|storage|cors|roles|logs|push|database|secrets|release|service|redeploy|park|unpark|load-up|load-down|status|teardown) ;;
  *) usage ;;
esac
guard
"phase_$(printf '%s' "$phase" | tr - _)" "$@"
