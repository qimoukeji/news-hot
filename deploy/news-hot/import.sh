#!/usr/bin/env bash
set -euo pipefail
umask 077
# Only run after explicit approval, stopped source writers and a successful restore rehearsal.
sha=${1:?Full verified release SHA}
dump=${2:?Approved custom-format dump}
files=${3:?Matching uploads and feedback screenshot archive}
source_audit=${4:?Source audit made while writers were stopped}
source "$(dirname "$0")/attachments.sh"
validate_attachments "$files"
source_audit=$(readlink -f "$source_audit")
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 2
root=/opt/news-hot
bundle=$root/incoming/$sha
release=$root/releases/$sha
tool=$(cd "$(dirname "$0")" && pwd)/manifest.cjs
[[ -f $root/shared/.env && ! -e $root/shared/initialized && ! -e $root/current ]] || { echo 'Import requires approved private config and a fresh deployment' >&2; exit 1; }
[[ -f $root/backups/import-rehearsal/verified-sha && $(cat "$root/backups/import-rehearsal/verified-sha") == "$sha" ]] || { echo 'Successful restore rehearsal is required' >&2; exit 1; }
sha256sum --check "$root/backups/import-rehearsal/SHA256SUMS" > /dev/null
read -r expected_dump expected_files expected_audit < "$root/backups/import-rehearsal/input-digests"
[[ $(sha256sum "$dump" | cut -d ' ' -f1) == "$expected_dump" && $(sha256sum "$files" | cut -d ' ' -f1) == "$expected_files" && $(sha256sum "$source_audit" | cut -d ' ' -f1) == "$expected_audit" ]] || { echo 'Import inputs differ from rehearsed backup' >&2; exit 1; }
exec 9>"$root/shared/release.lock"
flock -x 9
for volume in news-hot_db news-hot_data; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo "Existing target volume $volume requires operator review; nothing overwritten" >&2; exit 1; fi
done
node "$tool" verify "$sha" "$bundle"
tar -tzf "$bundle/source.tar.gz" > "$bundle/source-paths.txt"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$bundle/source-paths.txt"; then exit 1; fi
mkdir -p "$release"
tar -xzf "$bundle/source.tar.gz" -C "$release"
cp "$bundle/release.json" "$release/release.json"
node "$tool" verify "$sha" "$bundle" "$release"
gzip -dc "$bundle/app-image.tar.gz" | docker load
gzip -dc "$bundle/db-image.tar.gz" | docker load
export NEWSHOT_ENV_FILE=$root/shared/.env RELEASE_SHA=$sha DEPLOY_IMAGE=news-hot:$sha
export DEPLOY_DB_IMAGE
DEPLOY_DB_IMAGE=$(node "$tool" get "$bundle/release.json" dbId)
[[ $(docker image inspect --format '{{.Id}}' "$DEPLOY_IMAGE") == "$(node "$tool" get "$bundle/release.json" appId)" ]] || exit 1
docker image inspect "$DEPLOY_DB_IMAGE" > /dev/null
dc() { docker compose -p news-hot --env-file "$NEWSHOT_ENV_FILE" -f "$release/deploy/news-hot/compose.yml" "$@"; }
dc run --rm --no-deps --entrypoint node setup -e 'for (const [k,v] of Object.entries(process.env)) { if ((["COLLECT_ENABLED","MODEL_CALLS_ENABLED","WEBHOOK_PUSH_ENABLED","INDEXNOW_SUBMIT_ENABLED"].includes(k) || /^FEISHU_.*_ENABLED$/.test(k)) && v === "true") process.exit(1); }'
started=false
cleanup_failure() {
  result=$?
  trap - EXIT
  if (( result != 0 )) && [[ $started == true ]]; then
    dc stop api worker web >&2 || true
    printf '%s\n' "$sha" > "$root/shared/import-failed"
    echo 'Import failed. Source and target volumes retained for diagnosis; no automatic deletion or overwrite.' >&2
  fi
  exit "$result"
}
trap cleanup_failure EXIT
dc up -d db
started=true
ready=false
for ((i=0; i<90; i++)); do if dc exec -T db pg_isready -h 127.0.0.1 -U newshot -d newshot >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
[[ $ready == true ]] || exit 1
dc exec -T db pg_restore --list < "$dump" > /dev/null
dc exec -T db pg_restore -U newshot -d newshot --no-owner --no-acl --exit-on-error < "$dump"
dc run --rm --no-deps --entrypoint node setup deploy/news-hot/audit.cjs capture > "$bundle/restored-audit.json"
node "$release/deploy/news-hot/audit.cjs" compare "$source_audit" "$bundle/restored-audit.json"
docker volume create news-hot_data > /dev/null
docker run --rm -i --network none --user 0 -v news-hot_data:/data "$DEPLOY_IMAGE" sh -c \
  'tar -xzf - -C /data; chown -R node:node /data' < "$files"
dc run --rm -T --no-deps --entrypoint node setup deploy/news-hot/audit.cjs files /data - /app/site/brand/contact < "$source_audit" > "$bundle/attachment-manifest.json"
node "$release/deploy/news-hot/audit.cjs" compare "$root/backups/import-rehearsal/attachment-manifest.json" "$bundle/attachment-manifest.json"
dc exec -T db psql -X -U newshot -d newshot -At -v ON_ERROR_STOP=1 -c 'SELECT name FROM schema_migrations ORDER BY name' > "$bundle/ledger.txt"
node "$tool" plan "$bundle/release.json" - "$bundle/ledger.txt" '' > "$bundle/import-plan.json"
if [[ $(node "$tool" get "$bundle/import-plan.json" needsMigration) == true ]]; then
  echo 'Restored database has pending migrations; explicit migration approval is required before initialization can finish' >&2
  exit 1
fi
dc up -d --no-deps api web
ready=false
for ((i=0; i<90; i++)); do if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/api/health; then ready=true; break; fi; sleep 2; done
[[ $ready == true ]] || exit 1
dc run --rm --no-deps --entrypoint node setup scripts/smoke.ts --base http://web:3000
dc restart api web
ready=false
for ((i=0; i<90; i++)); do if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/api/health; then ready=true; break; fi; sleep 2; done
[[ $ready == true ]] || exit 1
dc run --rm --no-deps --entrypoint node setup scripts/smoke.ts --base http://web:3000
printf '%s\n' "$DEPLOY_DB_IMAGE" > "$root/shared/db-image-id"
printf '%s\n' "$sha" > "$root/shared/published-sha"
ln -s "$release" "$root/current"
printf '%s\n' "$sha" > "$root/shared/initialized"
echo 'Imported, verified and restarted. Collection/model/push must remain disabled until separate operating approval.'
