#!/usr/bin/env bash
# Exercise the actual release script with fake external processes. No live Docker,
# database, network, credentials, or repository modifications are involved.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tool=$here/../manifest.cjs
release_script=$here/../release.sh
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
old_sha=$(printf '1%.0s' {1..40})
new_sha=$(printf '2%.0s' {1..40})
app_id=sha256:$(printf 'a%.0s' {1..64})
db_id=sha256:$(printf 'b%.0s' {1..64})
passed=0

# Optional Node wrapper supports WSL with Windows Node when Linux Node is absent.
if [[ -n ${NEWSHOT_TEST_NODE_EXE:-} ]]; then
  mkdir -p "$temp/node-bin"
  cat > "$temp/node-bin/node" <<'NODE'
#!/usr/bin/env bash
set -euo pipefail
args=()
for arg in "$@"; do
  if [[ $arg == /* && -e $arg ]]; then arg=$(wslpath -w "$arg"); fi
  args+=("$arg")
done
exec "$NEWSHOT_TEST_NODE_EXE" "${args[@]}"
NODE
  chmod +x "$temp/node-bin/node"
  export PATH="$temp/node-bin:$PATH"
fi
command -v node > /dev/null

die() { echo "FAIL: $*" >&2; exit 1; }
assert_no_stop() { ! grep -q ' stop api worker web' "$log" || die "$case_name stopped the running site"; }
assert_old_restart() { grep -q "$old_sha .* up -d --no-deps api worker web" "$log" || die "$case_name did not restore previous app"; }
assert_current() { [[ $(readlink "$root/current") == "$root/releases/$1" ]] || die "$case_name published wrong release"; }
expect_failure() { if bash "$release_script" apply "$new_sha" "${1:-}" > "$root/output" 2>&1; then die "$case_name unexpectedly succeeded"; fi; }
ok() { passed=$((passed + 1)); echo "PASS: $case_name"; }

fixture() {
  case_name=$1
  root=$temp/$case_name
  source=$root/source
  bundle=$root/incoming/$new_sha
  log=$root/docker.log
  mkdir -p "$root/shared" "$root/releases/$old_sha" "$root/bin" "$bundle" "$source/database/migrations" "$source/deploy/news-hot"
  : > "$log"
  : > "$root/shared/.env"
  : > "$root/shared/initialized"
  printf '%s\n' "$db_id" > "$root/shared/db-image-id"
  printf '0001_base.sql\n' > "$root/ledger"
  printf 'SELECT 1;\n' > "$source/database/migrations/0001_base.sql"
  printf 'services: {}\n' > "$source/deploy/news-hot/compose.yml"
  printf 'app-image\n' | gzip > "$bundle/app-image.tar.gz"
  printf 'db-image\n' | gzip > "$bundle/db-image.tar.gz"
  git -C "$source" init -q
  git -C "$source" add .
  git -C "$source" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
  git -C "$source" archive HEAD | gzip > "$bundle/source.tar.gz"
  node "$tool" create "$old_sha" "$bundle" "$source" "$app_id" "$db_id"
  cp "$bundle/release.json" "$root/releases/$old_sha/release.json"
  mkdir -p "$root/releases/$old_sha/deploy/news-hot"
  cp "$source/deploy/news-hot/compose.yml" "$root/releases/$old_sha/deploy/news-hot/compose.yml"
  ln -s "$root/releases/$old_sha" "$root/current"
  cat > "$root/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "${RELEASE_SHA:-unset}" "$*" >> "$TEST_LOG"
if [[ $1 == load ]]; then cat >/dev/null; exit 0; fi
if [[ $1 == image ]]; then printf '%s\n' "$TEST_APP_ID"; exit 0; fi
if [[ $1 == run ]]; then tar -czf - -T /dev/null; exit 0; fi
[[ $1 == compose ]] || exit 90
shift
while [[ $1 == -* ]]; do
  case $1 in -p|--env-file|-f) shift 2;; *) exit 91;; esac
done
case $1 in
  config|stop) exit 0;;
  up)
    if [[ $FAIL_STAGE == start && $RELEASE_SHA != "$TEST_OLD_SHA" ]]; then exit 15; fi;;
  exec)
    if [[ $* == *' db psql '* ]]; then cat "$TEST_LEDGER";
    elif [[ $* == *' db pg_dump '* ]]; then
      [[ $FAIL_STAGE != backup ]] || exit 12
      printf 'fake-database-dump\n'
    elif [[ $* == *' db pg_restore '* ]]; then cat >/dev/null;
    elif [[ $* == *' web printenv AIHOT_RELEASE'* ]]; then printf '%s\n' "$RELEASE_SHA";
    else exit 92; fi;;
  run)
    if [[ $* == 'run --rm --no-deps setup' && $FAIL_STAGE == migration ]]; then exit 13; fi
    if [[ $* == *scripts/smoke.ts* && $FAIL_STAGE == smoke ]]; then exit 14; fi;;
  *) exit 93;;
esac
DOCKER
  cat > "$root/bin/curl" <<'CURL'
#!/usr/bin/env bash
[[ $FAIL_STAGE != health || $RELEASE_SHA == "$TEST_OLD_SHA" ]]
CURL
  cat > "$root/bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
# Skip backoff time; curl is still executed by the real release script.
exit 0
SLEEP
  chmod +x "$root/bin/"*
  export NEWSHOT_ROOT=$root TEST_LOG=$log TEST_APP_ID=$app_id TEST_LEDGER=$root/ledger TEST_OLD_SHA=$old_sha FAIL_STAGE=none
  export PATH="$root/bin:$PATH"
}

candidate() {
  if [[ ${1:-} == migration ]]; then printf 'SELECT 2;\n' > "$source/database/migrations/0002_next.sql"; fi
  git -C "$source" add .
  git -C "$source" -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm candidate
  git -C "$source" archive HEAD | gzip > "$bundle/source.tar.gz"
  node "$tool" create "$new_sha" "$bundle" "$source" "$app_id" "$db_id"
}
approval() {
  bash "$release_script" prepare "$new_sha" > "$root/prepare.json" 2> "$root/prepare.log"
  node "$tool" get "$root/prepare.json" approvalDigest
}

fixture missing_approval
candidate migration
expect_failure
assert_no_stop
assert_current "$old_sha"
grep -q 'approval missing or stale' "$root/output" || die 'missing approval reason absent'
ok

fixture stale_approval
candidate migration
approved=$(approval)
printf '0002_next.sql\n' >> "$root/ledger"
expect_failure "$approved"
assert_no_stop
assert_current "$old_sha"
grep -q 'approval is stale' "$root/output" || die 'stale approval reason absent'
ok

fixture backup_failure
candidate
export FAIL_STAGE=backup
expect_failure
assert_old_restart
assert_current "$old_sha"
[[ ! -e $root/shared/blocked-release ]] || die 'backup failure falsely marked a failed migration'
ok

fixture migration_failure
candidate migration
approved=$(approval)
export FAIL_STAGE=migration
expect_failure "$approved"
grep -q "$new_sha .* stop api worker web" "$log" || die 'failed migration did not stop candidate'
! grep -q ' up -d --no-deps api worker web' "$log" || die 'failed migration restarted an application'
[[ $(cat "$root/shared/blocked-release") == "$new_sha" ]] || die 'migration failure marker missing'
assert_current "$old_sha"
ok

fixture ordinary_success
candidate
bash "$release_script" apply "$new_sha" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'ordinary update failed'; }
assert_current "$new_sha"
[[ $(cat "$root/shared/published-sha") == "$new_sha" ]] || die 'published SHA missing'
[[ -s $(find "$root/backups" -name newshot.dump -print -quit) ]] || die 'database backup missing'
ok

fixture web_health_failure
candidate
export FAIL_STAGE=health
expect_failure
assert_old_restart
assert_current "$old_sha"
[[ ! -e $root/shared/blocked-release ]] || die 'health failure falsely blocked recovered release'
ok

fixture web_start_failure
candidate
export FAIL_STAGE=start
expect_failure
assert_old_restart
assert_current "$old_sha"
[[ ! -e $root/shared/blocked-release ]] || die 'start failure falsely blocked recovered release'
ok

fixture migrated_release_health_failure
candidate migration
approved=$(approval)
export FAIL_STAGE=health
expect_failure "$approved"
! grep -q "$old_sha .* up -d --no-deps api worker web" "$log" || die 'post-migration validation failure restored old app'
[[ $(cat "$root/shared/blocked-release") == "$new_sha" ]] || die 'post-migration failure marker missing'
assert_current "$old_sha"
# Subsequent attempts must not touch the database or restart any service.
: > "$log"
expect_failure "$approved"
[[ ! -s $log ]] || die 'blocked release touched Docker on retry'
ok

fixture tampered_artifact
candidate
printf 'tamper' >> "$bundle/app-image.tar.gz"
expect_failure
assert_no_stop
assert_current "$old_sha"
ok

echo "$passed release integration scenarios passed"
