#!/usr/bin/env bash
set -euo pipefail
umask 077
command=${1:?prepare or apply}
sha=${2:?Full commit SHA}
approval=${3:-}
[[ $sha =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 2; }
[[ $command == prepare || $command == apply ]] || exit 2
root=${NEWSHOT_ROOT:-/opt/news-hot}
tool=$(cd "$(dirname "$0")" && pwd)/manifest.cjs
bundle=$root/incoming/$sha
release=$root/releases/$sha
[[ -f $root/shared/.env && -f $root/shared/initialized && -f $root/shared/db-image-id ]] || {
  echo 'Approved bootstrap and data import must finish before automatic deployment' >&2; exit 1;
}
exec 9>"$root/shared/release.lock"
flock -x 9
export NEWSHOT_ENV_FILE=$root/shared/.env RELEASE_SHA=$sha DEPLOY_IMAGE=news-hot:$sha
export DEPLOY_DB_IMAGE
DEPLOY_DB_IMAGE=$(cat "$root/shared/db-image-id")
dc() { docker compose -p news-hot --env-file "$NEWSHOT_ENV_FILE" -f "$1/deploy/news-hot/compose.yml" "${@:2}"; }
get() { node "$tool" get "$1" "$2"; }
current=$(readlink -f "$root/current")
[[ $current == "$root/releases/"* && -f $current/release.json ]] || { echo 'Missing verified current release' >&2; exit 1; }
current_sha=$(get "$current/release.json" sha)
[[ $current == "$root/releases/$current_sha" ]] || exit 1
phase=prepare
migration_started=false
restart_previous() {
  export RELEASE_SHA=$current_sha DEPLOY_IMAGE=news-hot:$current_sha
  dc "$current" up -d --no-deps api worker web >&2
}
failed() {
  result=$?
  trap - EXIT
  if (( result != 0 )) && [[ $phase != prepare ]]; then
    if [[ $migration_started == true ]]; then
      dc "$release" stop api worker web >&2 || true
      printf '%s\n' "$sha" > "$root/shared/blocked-release"
      echo 'Migration or subsequent validation failed. Application stays stopped; review backup and database before recovery.' >&2
    else
      # Stop a partially started candidate before returning to the previous version.
      dc "$release" stop api worker web >&2 || true
      if ! restart_previous; then
        printf '%s\n' "$sha" > "$root/shared/blocked-release"
        echo 'Previous application could not restart; operator intervention required.' >&2
      fi
    fi
  fi
  exit "$result"
}
trap failed EXIT
[[ ! -e $root/shared/blocked-release ]] || { echo 'A failed migration or recovery requires operator intervention' >&2; exit 1; }
node "$tool" verify "$sha" "$bundle"
if [[ ! -d $release ]]; then
  # The bundle is made with git archive, and must only contain relative repository paths.
  tar -tzf "$bundle/source.tar.gz" > "$bundle/source-paths.txt"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$bundle/source-paths.txt"; then echo 'Unsafe source archive path' >&2; exit 1; fi
  mkdir -p "$release"
  tar -xzf "$bundle/source.tar.gz" -C "$release"
  cp "$bundle/release.json" "$release/release.json"
fi
node "$tool" verify "$sha" "$bundle" "$release"
cmp "$bundle/release.json" "$release/release.json"
gzip -dc "$bundle/app-image.tar.gz" | docker load >&2
[[ $(docker image inspect --format '{{.Id}}' "$DEPLOY_IMAGE") == "$(get "$bundle/release.json" appId)" ]] || { echo 'Loaded image identity mismatch' >&2; exit 1; }
dc "$release" config --quiet
dc "$current" exec -T db psql -X -U newshot -d newshot -At -v ON_ERROR_STOP=1 \
  -c 'SELECT name FROM schema_migrations ORDER BY name' > "$bundle/ledger.txt"
node "$tool" plan "$bundle/release.json" "$current/release.json" "$bundle/ledger.txt" "$current_sha" > "$bundle/plan.json"
if [[ $command == prepare ]]; then
  cat "$bundle/plan.json"
  exit 0
fi
digest=$(get "$bundle/plan.json" approvalDigest)
needs_migration=$(get "$bundle/plan.json" needsMigration)
if [[ $needs_migration == true ]]; then
  [[ $approval =~ ^[a-f0-9]{64}$ && $approval == "$digest" ]] || { echo 'Migration approval missing or stale; running site unchanged' >&2; exit 1; }
elif [[ -n $approval && $approval != "$digest" ]]; then
  echo 'Release approval is stale' >&2; exit 1
fi
if [[ $current_sha == "$sha" ]]; then echo 'This release is already published' >&2; exit 0; fi
phase=stopping
dc "$current" stop api worker web >&2
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$root/backups/$stamp-$sha
mkdir -p "$backup"
dc "$current" exec -T db pg_dump -U newshot -d newshot -Fc --no-owner > "$backup/newshot.dump"
dc "$current" exec -T db pg_restore --list < "$backup/newshot.dump" > /dev/null
docker run --rm --network none -v news-hot_data:/data:ro "$DEPLOY_IMAGE" sh -c \
  'cd /data; set --; for d in uploads feedback-screenshots; do if [ -d "$d" ]; then set -- "$@" "$d"; fi; done; if [ "$#" -eq 0 ]; then tar -czf - -T /dev/null; else tar -czf - "$@"; fi' > "$backup/files.tar.gz"
tar -tzf "$backup/files.tar.gz" > /dev/null
sha256sum "$backup/newshot.dump" "$backup/files.tar.gz" > "$backup/SHA256SUMS"
cp "$bundle/plan.json" "$backup/plan.json"
if [[ $needs_migration == true ]]; then
  migration_started=true
  phase=migrating
  dc "$release" run --rm --no-deps setup >&2
else
  dc "$release" run --rm --no-deps --entrypoint node setup scripts/seed.ts >&2
fi
phase=starting
dc "$release" up -d --no-deps api worker web >&2
healthy=false
for ((i=0; i<90; i++)); do
  if curl --fail --silent --max-time 5 --output /dev/null http://127.0.0.1:3000/api/health; then healthy=true; break; fi
  sleep 2
done
[[ $healthy == true ]] || { echo 'Candidate health check failed' >&2; exit 1; }
dc "$release" run --rm --no-deps --entrypoint node setup scripts/smoke.ts --base http://web:3000 >&2
[[ $(dc "$release" exec -T web printenv AIHOT_RELEASE) == "$sha" ]] || { echo 'Web release identity mismatch' >&2; exit 1; }
# Commit publication only after all checks. The old symlink remains valid on every prior failure.
ln -s "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
printf '%s\n' "$sha" > "$root/shared/published-sha"
phase=prepare
echo "Published $sha" >&2
