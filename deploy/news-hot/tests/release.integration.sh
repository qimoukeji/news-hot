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
# WSL does not forward newly exported Linux variables to Windows processes automatically.
export WSLENV="${WSLENV:+$WSLENV:}TEST_HISTORY_FINGERPRINT:TEST_HISTORY_CHANGES"
exec "$NEWSHOT_TEST_NODE_EXE" "${args[@]}"
NODE
  chmod +x "$temp/node-bin/node"
  export PATH="$temp/node-bin:$PATH"
fi
command -v node > /dev/null

die() { echo "FAIL: $*" >&2; if [[ -f ${root:-}/output ]]; then cat "$root/output" >&2; fi; exit 1; }
assert_no_stop() { ! grep -q ' stop api worker web' "$log" || die "$case_name stopped the running site"; }
assert_old_restart() {
  grep -q "$old_sha .* up -d --no-deps api web" "$log" || die "$case_name did not restore previous app";
  if [[ $TEST_WORKER_RUNNING == true ]]; then
    grep -q "$old_sha .* up -d --no-deps worker" "$log" || die "$case_name did not restore running worker";
  else
    ! grep -q ' up -d --no-deps worker' "$log" || die "$case_name started a stopped worker";
  fi
}
assert_current() { [[ $(readlink "$root/current") == "$root/releases/$1" ]] || die "$case_name published wrong release"; }
expect_failure() { if bash "$release_script" apply "$new_sha" "${1:-}" "${2:-}" > "$root/output" 2>&1; then die "$case_name unexpectedly succeeded"; fi; }
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
  ps)
    [[ $FAIL_STAGE != worker_state ]] || exit 17
    if [[ $TEST_WORKER_RUNNING == true ]]; then echo fake-worker; fi;;
  up)
    if [[ $FAIL_PREVIOUS_START == true && $RELEASE_SHA == "$TEST_OLD_SHA" ]]; then exit 18; fi
    if [[ $FAIL_STAGE == start && $RELEASE_SHA != "$TEST_OLD_SHA" ]]; then exit 15; fi;;
  exec)
    if [[ $* == *' db psql '* ]]; then cat "$TEST_LEDGER";
    elif [[ $* == *' db pg_dump '* ]]; then
      [[ $FAIL_STAGE != backup ]] || exit 12
      printf 'fake-database-dump\n'
    elif [[ $* == *' db pg_restore '* ]]; then
      cat >/dev/null
      [[ $FAIL_STAGE != backup_validation ]] || exit 19
    elif [[ $* == *' web printenv AIHOT_RELEASE'* ]]; then printf '%s\n' "$RELEASE_SHA";
    else exit 92; fi;;
  run)
    if [[ $* == *'accessSync("modules/reset-monitor/scripts/migrate-business-time.ts")'* && $FAIL_STAGE == business_tool ]]; then exit 20; fi
    if [[ $* == *'scripts/migrate.ts --through 0146_monitor_actions_business_time.sql'* && $FAIL_STAGE == business_cutoff ]]; then exit 21; fi
    if [[ $* == *'modules/reset-monitor/scripts/migrate-business-time.ts --apply '* ]]; then
      args=("$@")
      output_parent=
      backup_file=
      for ((i=0; i<${#args[@]}; i++)); do
        if [[ ${args[i]} == -v ]]; then
          volume=${args[i+1]}
          if [[ $volume == *:/run/newshot-business-time ]]; then output_parent=${volume%:/run/newshot-business-time}; fi
          if [[ $volume == *:/run/newshot-backup.dump:ro ]]; then backup_file=${volume%:/run/newshot-backup.dump:ro}; fi
        fi
      done
      [[ -s $backup_file && -d $output_parent && ! -e $output_parent/apply ]] || exit 22
      [[ $(stat -c %a "$output_parent") == 700 ]] || exit 23
      [[ $* == *'--worker-stopped --database-backup /run/newshot-backup.dump --output /run/newshot-business-time/apply'* ]] || exit 24
      mkdir "$output_parent/apply"
      printf '{"fakeConversion":true}\n' > "$output_parent/apply/report.json"
      [[ $FAIL_STAGE != business_conversion ]] || exit 25
    fi
    if [[ $* == *scripts/cleanup-monitor-history.ts* ]]; then
      if [[ $* == *' --apply '* ]]; then
        [[ $FAIL_STAGE != cleanup ]] || exit 16
      else
        node -e 'console.log(JSON.stringify({fingerprint:process.env.TEST_HISTORY_FINGERPRINT,deletedPosts:process.env.TEST_HISTORY_CHANGES === "true" ? [{monitor_id:"grok",id:"1"}] : [],updatedPosts:[],deletedStates:[],updatedStates:[]}))'
      fi
    fi
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
  export TEST_WORKER_RUNNING=true TEST_HISTORY_FINGERPRINT=$(printf 'c%.0s' {1..64}) TEST_HISTORY_CHANGES=true FAIL_PREVIOUS_START=false
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
! grep -q ' up -d --no-deps ' "$log" || die 'failed migration restarted an application'
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
! grep -q "$old_sha .* up -d --no-deps " "$log" || die 'post-migration validation failure restored old app'
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

history_candidate() {
  mkdir -p "$source/scripts"
  printf '// History cleanup entrypoint\n' > "$source/scripts/cleanup-monitor-history.ts"
  candidate "${1:-}"
}
history_approval() {
  bash "$release_script" prepare "$new_sha" > "$root/prepare.json" 2> "$root/prepare.log"
  node "$tool" get "$root/prepare.json" historyFingerprint
}
assert_blocked() {
  [[ $(cat "$root/shared/blocked-release") == "$new_sha" ]] || die "$case_name did not block release"
  ! grep -q "$old_sha .* up -d --no-deps " "$log" || die "$case_name restored incompatible old app"
  assert_current "$old_sha"
}

fixture history_missing_approval
history_candidate
expect_failure
assert_no_stop
grep -q 'History cleanup approval missing or stale' "$root/output" || die 'history approval reason missing'
ok

fixture history_stale_approval
history_candidate
approved_history=$(history_approval)
export TEST_HISTORY_FINGERPRINT=$(printf 'd%.0s' {1..64})
expect_failure '' "$approved_history"
assert_no_stop
ok

fixture independent_approvals
history_candidate migration
approved_history=$(history_approval)
approved=$(node "$tool" get "$root/prepare.json" approvalDigest)
expect_failure "$approved" "$approved"
assert_no_stop
expect_failure "$approved_history" "$approved_history"
assert_no_stop
ok

fixture history_success
history_candidate
approved_history=$(history_approval)
bash "$release_script" apply "$new_sha" '' "$approved_history" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'history update failed'; }
assert_current "$new_sha"
! grep -q ' up -d --no-deps worker' "$log" || die 'history update started worker'
node - "$log" <<'NODE'
const fs = require('fs');
const log = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const steps = [' stop api worker web', ' db pg_dump ', ' db pg_restore ', 'scripts/cleanup-monitor-history.ts --apply', ' up -d --no-deps api web', 'scripts/smoke.ts'];
let previous = -1;
for (const step of steps) {
  const index = log.findIndex(line => line.includes(step));
  if (index <= previous) throw new Error('Invalid deployment order: ' + step);
  previous = index;
}
if (!log.some(line => /-v .*newshot\.dump:\/run\/newshot-backup\.dump:ro/.test(line))) throw new Error('Backup must be mounted read-only');
if (!log.some(line => /--user \d+:\d+ .*scripts\/cleanup-monitor-history.ts --apply/.test(line))) throw new Error('Cleanup must use the backup owner numeric UID/GID');
NODE
[[ -s $bundle/history-plan.json ]] || die 'private history preview missing'
ok

fixture history_no_changes
history_candidate
export TEST_HISTORY_CHANGES=false
bash "$release_script" apply "$new_sha" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'empty history plan required approval'; }
! grep -q 'scripts/cleanup-monitor-history.ts --apply' "$log" || die 'empty history plan was applied'
! grep -q ' up -d --no-deps worker' "$log" || die 'history transition started worker'
assert_current "$new_sha"
ok

fixture history_backup_validation_failure
history_candidate
approved_history=$(history_approval)
export FAIL_STAGE=backup_validation
expect_failure '' "$approved_history"
! grep -q 'scripts/cleanup-monitor-history.ts --apply' "$log" || die 'unverified backup reached cleanup'
assert_old_restart
assert_current "$old_sha"
[[ ! -e $root/shared/blocked-release ]] || die 'backup validation failure falsely blocked rollback'
ok

for stage in cleanup smoke; do
  fixture "history_${stage}_failure"
  history_candidate
  approved_history=$(history_approval)
  export FAIL_STAGE=$stage
  expect_failure '' "$approved_history"
  assert_blocked
  ! grep -q ' up -d --no-deps worker' "$log" || die 'failed cleanup release started worker'
  ok
done

for stage in none backup health start; do
  fixture "stopped_worker_${stage}"
  export TEST_WORKER_RUNNING=false FAIL_STAGE=$stage
  candidate
  if [[ $stage == none ]]; then
    bash "$release_script" apply "$new_sha" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'ordinary update with stopped worker failed'; }
    assert_current "$new_sha"
  else
    expect_failure
    assert_old_restart
    assert_current "$old_sha"
  fi
  ! grep -q ' up -d --no-deps worker' "$log" || die 'ordinary release started stopped worker'
  ok
done

fixture later_posts_only_release
mkdir -p "$root/releases/$old_sha/scripts" "$source/scripts"
printf '// Already installed\n' > "$root/releases/$old_sha/scripts/cleanup-monitor-history.ts"
cp "$root/releases/$old_sha/scripts/cleanup-monitor-history.ts" "$source/scripts/cleanup-monitor-history.ts"
candidate
bash "$release_script" apply "$new_sha" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'later posts-only release failed'; }
! grep -q scripts/cleanup-monitor-history.ts "$log" || die 'later release repeated history cleanup'
grep -q "$new_sha .* up -d --no-deps worker" "$log" || die 'later release did not preserve running worker'
assert_current "$new_sha"
ok

fixture worker_state_unknown
candidate
export FAIL_STAGE=worker_state
expect_failure
assert_no_stop
assert_current "$old_sha"
ok

fixture previous_restart_failure
candidate
export FAIL_STAGE=health FAIL_PREVIOUS_START=true
expect_failure
[[ $(cat "$root/shared/blocked-release") == "$new_sha" ]] || die 'failed previous restart did not block release'
assert_current "$old_sha"
ok

business_candidate() {
  mkdir -p "$source/modules/reset-monitor/migrations" "$source/modules/reset-monitor/scripts"
  for name in 0146_monitor_actions_business_time 0147_monitor_actions_business_time_check 0148_monitor_actions_validate_business_time 0149_monitor_actions_structured_sources_check 0150_monitor_actions_validate_structured_sources 0151_monitor_actions_drop_scalar_sources_check 0152_monitor_actions_drop_scalar_time 0153_monitor_actions_rename_business_time; do
    printf 'SELECT 1;\n' > "$source/modules/reset-monitor/migrations/$name.sql"
  done
  if [[ ${1:-} != missing ]]; then printf '// Conversion entrypoint\n' > "$source/modules/reset-monitor/scripts/migrate-business-time.ts"; fi
  candidate
}

fixture business_missing_source_tool
business_candidate missing
expect_failure
assert_no_stop
assert_current "$old_sha"
grep -q 'lacks the business time conversion tool' "$root/output" || die 'missing conversion tool reason absent'
ok

fixture business_missing_image_tool
business_candidate
export FAIL_STAGE=business_tool
expect_failure
assert_no_stop
assert_current "$old_sha"
ok

fixture business_missing_approval
business_candidate
expect_failure
assert_no_stop
ok

fixture business_stale_approval
business_candidate
approved=$(approval)
[[ $(node "$tool" get "$root/prepare.json" needsBusinessTimeUpgrade) == true ]] || die 'conversion absent from plan'
printf '0146_monitor_actions_business_time.sql\n' >> "$root/ledger"
expect_failure "$approved"
assert_no_stop
ok

for state in legacy partial empty; do
  fixture "business_success_$state"
  business_candidate
  if [[ $state == partial ]]; then printf '0146_monitor_actions_business_time.sql\n' >> "$root/ledger"; fi
  if [[ $state == empty ]]; then : > "$root/ledger"; fi
  approved=$(approval)
  : > "$log"
  bash "$release_script" apply "$new_sha" "$approved" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'business time update failed'; }
  assert_current "$new_sha"
  node - "$log" <<'NODE'
const fs = require('fs');
const log = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const steps = ['accessSync(', ' stop api worker web', ' db pg_dump ', ' db pg_restore ', ' run --rm --network none ', 'scripts/migrate.ts --through 0146_monitor_actions_business_time.sql', 'modules/reset-monitor/scripts/migrate-business-time.ts --apply', ' run --rm --no-deps setup', ' up -d --no-deps api web', 'scripts/smoke.ts'];
let previous = -1;
for (const step of steps) {
  const index = log.findIndex(line => line.includes(step));
  if (index <= previous) throw new Error('Invalid business time deployment order: ' + step);
  previous = index;
}
const conversion = log.find(line => line.includes('migrate-business-time.ts --apply'));
if (!/--user \d+:\d+ /.test(conversion)) throw new Error('Conversion must use backup owner UID/GID');
if (!/-v .*newshot\.dump:\/run\/newshot-backup\.dump:ro/.test(conversion)) throw new Error('Conversion backup must be read-only');
if (!conversion.includes('/business-time:/run/newshot-business-time ')) throw new Error('Conversion needs a writable private output parent');
NODE
  [[ -s $(find "$root/backups" -name report.json -print -quit) ]] || die 'conversion report was not preserved with backup'
  ok
done

for stage in business_cutoff business_conversion migration health; do
  fixture "business_${stage}_failure"
  business_candidate
  approved=$(approval)
  export FAIL_STAGE=$stage
  : > "$log"
  expect_failure "$approved"
  assert_blocked
  ! grep -q ' up -d --no-deps worker' "$log" || die 'failed business time release started worker'
  if [[ $stage == business_cutoff ]]; then
    ! grep -q 'migrate-business-time.ts --apply' "$log" || die 'failed cutoff reached conversion'
  fi
  if [[ $stage == business_cutoff || $stage == business_conversion ]]; then
    ! grep -q ' run --rm --no-deps setup$' "$log" || die 'failed conversion reached final migrations'
  fi
  : > "$log"
  expect_failure "$approved"
  [[ ! -s $log ]] || die 'blocked conversion retry touched Docker'
  ok
done

fixture business_backup_validation_failure
business_candidate
approved=$(approval)
export FAIL_STAGE=backup_validation
expect_failure "$approved"
assert_old_restart
! grep -q 'scripts/migrate.ts --through' "$log" || die 'invalid backup reached cutoff'
[[ ! -e $root/shared/blocked-release ]] || die 'pre-migration backup failure blocked recovery'
ok

fixture business_already_converted
business_candidate
find "$source/modules/reset-monitor/migrations" -name '*.sql' -printf '%f\n' | sort >> "$root/ledger"
bash "$release_script" apply "$new_sha" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'already converted release failed'; }
! grep -q 'migrate-business-time.ts' "$log" || die 'already converted release repeated conversion'
grep -q 'scripts/seed.ts' "$log" || die 'ordinary release did not seed'
assert_current "$new_sha"
ok

fixture ordinary_migration_success
candidate migration
approved=$(approval)
bash "$release_script" apply "$new_sha" "$approved" > "$root/output" 2>&1 || { cat "$root/output" >&2; die 'ordinary migration failed'; }
! grep -q 'migrate-business-time.ts\|scripts/migrate.ts --through' "$log" || die 'ordinary migration ran business conversion'
[[ $(grep -c ' run --rm --no-deps setup$' "$log") == 1 ]] || die 'ordinary migration setup changed'
assert_current "$new_sha"
ok

echo "$passed release integration scenarios passed"
