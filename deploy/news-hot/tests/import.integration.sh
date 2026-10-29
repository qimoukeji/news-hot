#!/usr/bin/env bash
# Run the actual import/rehearsal scripts against fake Docker and HTTP commands, entirely in /tmp.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
temp=$(mktemp -d /tmp/news-hot-import-test-XXXXXX)
trap 'rm -rf -- "$temp"' EXIT
sha=$(printf '2%.0s' {1..40})
app_id=sha256:$(printf 'a%.0s' {1..64})
db_id=sha256:$(printf 'b%.0s' {1..64})
mkdir -p "$temp/bin" "$temp/tools"
cp "$here/../attachments.sh" "$here/../manifest.cjs" "$temp/tools/"
cat > "$temp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_LOG"
case "$1" in
  volume) [[ $2 != inspect ]]; exit;;
  load) cat >/dev/null; exit;;
  image) if [[ $* == *--format* ]]; then printf '%s\n' "$TEST_APP_ID"; fi; exit;;
  run) cat >/dev/null; exit;;
  compose) shift;;
  *) exit 90;;
esac
while [[ $1 == -* ]]; do case "$1" in -p|--env-file|-f) shift 2;; *) exit 91;; esac; done
case "$1" in
  config|up|stop|restart) exit;;
  exec)
    if [[ $* == *' db pg_restore '* ]]; then cat >/dev/null;
    elif [[ $* == *' db psql '* ]]; then printf '0001_base.sql\n';
    elif [[ $* != *' db pg_isready '* ]]; then exit 92; fi;;
  run)
    args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
      if [[ ${args[i]} == -e ]]; then node -e "${args[i+1]}"; exit; fi
    done
    if [[ $* == *'audit.cjs capture'* ]]; then cat "$TEST_SOURCE_AUDIT";
    elif [[ $* == *'audit.cjs files'* ]]; then printf '{"format":1,"files":[]}\n';
    elif [[ $* != *scripts/smoke.ts* ]]; then exit 93; fi;;
  *) exit 94;;
esac
DOCKER
printf '#!/usr/bin/env bash\nexit 0\n' > "$temp/bin/curl"
chmod +x "$temp/bin/"*
export PATH="$temp/bin:$PATH" TEST_APP_ID=$app_id
export COLLECT_ENABLED=false MODEL_CALLS_ENABLED=false WEBHOOK_PUSH_ENABLED=false INDEXNOW_SUBMIT_ENABLED=false
export FEISHU_CONTENT_PUSH_ENABLED=false FEISHU_INTERNAL_ENABLED=false

fixture() {
  root=$temp/$1
  source=$root/source
  bundle=$root/incoming/$sha
  mkdir -p "$root/shared" "$root/backups/import-rehearsal" "$source/deploy/news-hot" "$source/database/migrations" "$bundle"
  : > "$root/shared/.env"
  printf 'SELECT 1;\n' > "$source/database/migrations/0001_base.sql"
  cp "$here/../manifest.cjs" "$here/../audit.cjs" "$source/deploy/news-hot/"
  printf 'services: {}\n' > "$source/deploy/news-hot/compose.yml"
  tar -czf "$bundle/source.tar.gz" -C "$source" .
  printf app | gzip > "$bundle/app-image.tar.gz"
  printf db | gzip > "$bundle/db-image.tar.gz"
  node "$temp/tools/manifest.cjs" create "$sha" "$bundle" "$source" "$app_id" "$db_id"
  printf 'synthetic dump\n' > "$root/source.dump"
  tar -czf "$root/files.tar.gz" -T /dev/null
  printf '{"attachmentRefs":[]}\n' > "$root/source-audit.json"
  printf '%s\n' "$sha" > "$root/backups/import-rehearsal/verified-sha"
  printf '{"format":1,"files":[]}\n' > "$root/backups/import-rehearsal/attachment-manifest.json"
  sha256sum "$root/source.dump" "$root/files.tar.gz" "$root/source-audit.json" > "$root/backups/import-rehearsal/SHA256SUMS"
  printf '%s %s %s\n' "$(sha256sum "$root/source.dump" | cut -d ' ' -f1)" "$(sha256sum "$root/files.tar.gz" | cut -d ' ' -f1)" "$(sha256sum "$root/source-audit.json" | cut -d ' ' -f1)" > "$root/backups/import-rehearsal/input-digests"
  # Substitute only the server's fixed root; all lifecycle and safety checks run unmodified.
  sed "s|^root=/opt/news-hot$|root=$root|" "$here/../import.sh" > "$temp/tools/import.sh"
  sed "s|^root=/opt/news-hot$|root=$root|" "$here/../rehearse.sh" > "$temp/tools/rehearse.sh"
  export TEST_LOG=$root/docker.log TEST_SOURCE_AUDIT=$root/source-audit.json
  : > "$TEST_LOG"
}
run_import() { bash "$temp/tools/import.sh" "$sha" "$root/source.dump" "$root/files.tar.gz" "$root/source-audit.json" > "$root/output" 2>&1; }

fixture paused_import
run_import || { cat "$root/output" >&2; exit 1; }
[[ -f $root/shared/initialized && $(readlink "$root/current") == "$root/releases/$sha" ]]
grep -q ' up -d --no-deps api web$' "$TEST_LOG"
grep -q ' restart api web$' "$TEST_LOG"
! grep -Eq ' (up|restart) .*worker' "$TEST_LOG"
echo 'PASS: import verifies and restarts API/web without starting worker'

fixture webhook_import
export WEBHOOK_PUSH_ENABLED=true
if run_import; then echo 'Enabled Webhook push permitted import' >&2; exit 1; fi
! grep -q ' up -d db' "$TEST_LOG"
[[ ! -e $root/shared/initialized ]]
echo 'PASS: enabled Webhook push stops import before database start'

mkdir -p "$root/releases/$sha"
cp -R "$source/". "$root/releases/$sha/"
cp "$bundle/release.json" "$root/releases/$sha/release.json"
: > "$TEST_LOG"
if bash "$temp/tools/rehearse.sh" "$sha" "$root/source.dump" "$root/files.tar.gz" "$root/source-audit.json" > "$root/output" 2>&1; then
  echo 'Enabled Webhook push permitted rehearsal' >&2; exit 1
fi
! grep -q ' up -d db' "$TEST_LOG"
echo 'PASS: enabled Webhook push stops rehearsal before database start'
echo '3 import/rehearsal scenarios passed; no real Docker, HTTP, or database operations ran'
