#!/usr/bin/env bash
set -euo pipefail
umask 077
sha=${1:?Verified release SHA}
dump=${2:?Source dump}
files=${3:?Source attachments}
source_audit=${4:?Source audit}
source "$(dirname "$0")/attachments.sh"
validate_attachments "$files"
source_audit=$(readlink -f "$source_audit")
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 2
root=/opt/news-hot
release=$root/releases/$sha
[[ -f $release/release.json && -f $root/shared/.env ]] || exit 1
exec 9>"$root/shared/release.lock"
flock -x 9
export NEWSHOT_ENV_FILE=$root/shared/.env RELEASE_SHA=$sha DEPLOY_IMAGE=news-hot:$sha
export DEPLOY_DB_IMAGE
DEPLOY_DB_IMAGE=$(node "$release/deploy/news-hot/manifest.cjs" get "$release/release.json" dbId)
project=news-hot-import-rehearsal
dc() { docker compose -p "$project" --env-file "$NEWSHOT_ENV_FILE" -f "$release/deploy/news-hot/compose.yml" "$@"; }
# Only this explicitly disposable project can ever be removed by this script.
for volume in "${project}_db" "${project}_data"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'A previous rehearsal is retained; review it before starting another' >&2; exit 1; fi
done
trap 'dc stop db >/dev/null 2>&1 || true' EXIT
dc run --rm --no-deps --entrypoint node setup -e 'for (const [k,v] of Object.entries(process.env)) { if ((["COLLECT_ENABLED","MODEL_CALLS_ENABLED","INDEXNOW_SUBMIT_ENABLED"].includes(k) || /^FEISHU_.*_ENABLED$/.test(k)) && v === "true") process.exit(1); }'
dc up -d db
ready=false
for ((i=0; i<90; i++)); do if dc exec -T db pg_isready -h 127.0.0.1 -U newshot -d newshot >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
[[ $ready == true ]] || exit 1
dc exec -T db pg_restore -U newshot -d newshot --no-owner --no-acl --exit-on-error < "$dump"
mkdir -p "$root/backups/import-rehearsal"
dc run --rm --no-deps --entrypoint node setup deploy/news-hot/audit.cjs capture > "$root/backups/import-rehearsal/restored-audit.json"
node "$release/deploy/news-hot/audit.cjs" compare "$source_audit" "$root/backups/import-rehearsal/restored-audit.json"
dc exec -T db psql -X -U newshot -d newshot -At -v ON_ERROR_STOP=1 -c 'SELECT name FROM schema_migrations ORDER BY name' > "$root/backups/import-rehearsal/ledger.txt"
node "$release/deploy/news-hot/manifest.cjs" plan "$release/release.json" - "$root/backups/import-rehearsal/ledger.txt" '' > "$root/backups/import-rehearsal/plan.json"
if [[ $(node "$release/deploy/news-hot/manifest.cjs" get "$root/backups/import-rehearsal/plan.json" needsMigration) == true ]]; then
  node "$release/deploy/news-hot/manifest.cjs" pending-sql "$root/backups/import-rehearsal/plan.json" "$release" >&2
  echo 'Initial release must match the source schema. Review pending migrations before importing; rehearsal retained.' >&2
  exit 1
fi
docker volume create "${project}_data" > /dev/null
docker run --rm -i --network none --user 0 -v "${project}_data:/data" "$DEPLOY_IMAGE" sh -c 'tar -xzf - -C /data; chown -R node:node /data' < "$files"
dc run --rm -T --no-deps --entrypoint node setup deploy/news-hot/audit.cjs files /data - /app/site/brand/contact < "$source_audit" > "$root/backups/import-rehearsal/attachment-manifest.json"
printf '%s\n' "$sha" > "$root/backups/import-rehearsal/verified-sha"
sha256sum "$dump" "$files" "$source_audit" > "$root/backups/import-rehearsal/SHA256SUMS"
printf '%s %s %s\n' "$(sha256sum "$dump" | cut -d ' ' -f1)" "$(sha256sum "$files" | cut -d ' ' -f1)" "$(sha256sum "$source_audit" | cut -d ' ' -f1)" > "$root/backups/import-rehearsal/input-digests"
dc stop db
echo 'Rehearsal passed; its database remains stopped and retained for inspection.'
