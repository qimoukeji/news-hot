#!/usr/bin/env bash
set -euo pipefail
export RELEASE_SHA=${1:?Full commit SHA} DEPLOY_IMAGE=${2:-news-hot:${1:?}}
export DEPLOY_DB_IMAGE
DEPLOY_DB_IMAGE=$(docker image inspect --format '{{.Id}}' postgres:18-alpine)
env_file=$(mktemp)
export NEWSHOT_ENV_FILE=$env_file
dc() { docker compose -p news-hot-package-test --env-file "$env_file" -f deploy/news-hot/compose.yml "$@"; }
cleanup() { dc down -v > /dev/null 2>&1 || true; rm -f "$env_file"; }
trap cleanup EXIT
umask 077
cat > "$env_file" <<EOF
SITE_URL=http://127.0.0.1:3000
POSTGRES_PASSWORD=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -hex 32)
IMG_PROXY_SIGN_SECRET=$(openssl rand -hex 32)
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
FEISHU_CONTENT_PUSH_ENABLED=false
FEISHU_INTERNAL_ENABLED=false
INDEXNOW_SUBMIT_ENABLED=false
EOF
dc up -d db
ready=false
for ((i=0; i<90; i++)); do if dc exec -T db pg_isready -h 127.0.0.1 -U newshot -d newshot >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
[[ $ready == true ]] || exit 1
dc run --rm --no-deps setup
dc up -d --no-deps api worker web
ready=false
for ((i=0; i<90; i++)); do if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/api/health; then ready=true; break; fi; sleep 2; done
[[ $ready == true ]] || exit 1
dc run --rm --no-deps --entrypoint node setup scripts/smoke.ts --base http://web:3000
[[ $(dc run --rm --no-deps --entrypoint pg_dump setup --version) == *'18.'* ]]
dc stop api worker web
dump=$(mktemp)
source_audit=$(mktemp)
restored_audit=$(mktemp)
source_files=$(mktemp)
restored_files=$(mktemp)
trap 'rm -f "$dump" "$source_audit" "$restored_audit" "$source_files" "$restored_files"; cleanup' EXIT
dc run --rm --no-deps --entrypoint node setup deploy/news-hot/audit.cjs capture > "$source_audit"
dc run --rm --no-deps --entrypoint node setup -e 'const fs=require("fs"); fs.mkdirSync("/data/uploads",{recursive:true}); fs.writeFileSync("/data/uploads/persistence-check.txt","persistent test attachment");'
dc run --rm -T --no-deps --entrypoint node setup deploy/news-hot/audit.cjs files /data - < "$source_audit" > "$source_files"
dc exec -T db pg_dump -U newshot -d newshot -Fc --no-owner > "$dump"
dc exec -T db createdb -U newshot restore_test
dc exec -T db pg_restore -U newshot -d restore_test --no-owner --no-acl --exit-on-error < "$dump"
dc exec -T db psql -X -U newshot -d restore_test -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM schema_migrations' | grep -Eq '^[1-9][0-9]*$'
dc run --rm --no-deps --entrypoint sh setup -c 'export DATABASE_URL="${DATABASE_URL%/*}/restore_test"; exec node deploy/news-hot/audit.cjs capture' > "$restored_audit"
node deploy/news-hot/audit.cjs compare "$source_audit" "$restored_audit"
# Recreate containers while retaining the two explicit project volumes.
dc stop db
dc rm -f db api worker web
dc up -d db
ready=false
for ((i=0; i<90; i++)); do if dc exec -T db pg_isready -h 127.0.0.1 -U newshot -d newshot >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
[[ $ready == true ]] || exit 1
dc run --rm --no-deps --entrypoint node setup deploy/news-hot/audit.cjs capture > "$restored_audit"
node deploy/news-hot/audit.cjs compare "$source_audit" "$restored_audit"
dc run --rm -T --no-deps --entrypoint node setup deploy/news-hot/audit.cjs files /data - < "$source_audit" > "$restored_files"
node deploy/news-hot/audit.cjs compare "$source_files" "$restored_files"
dc up -d --no-deps api worker web
dc restart api worker web
ready=false
for ((i=0; i<90; i++)); do if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/api/health; then ready=true; break; fi; sleep 2; done
[[ $ready == true ]] || exit 1
dc run --rm --no-deps --entrypoint node setup scripts/smoke.ts --base http://web:3000
