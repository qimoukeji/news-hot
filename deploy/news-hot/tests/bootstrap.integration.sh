#!/usr/bin/env bash
# Run in the disposable container via bootstrap.sh, never against a server.
set -euo pipefail
[[ ${NEWSHOT_TEST_ISOLATED:-} == true && -f /.dockerenv ]] || { echo 'Disposable test container required' >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/bin"
export TEST_LOG=$temp/commands.log
: > "$TEST_LOG"
for command in docker useradd install chown chmod; do
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "unexpected %s $*" >> "$TEST_LOG"\nexit 98\n' "$command" > "$temp/bin/$command"
  /bin/chmod +x "$temp/bin/$command"
done
export PATH="$temp/bin:$PATH"
sha=$(printf '2%.0s' {1..40})
tar -czf "$temp/no.tar.gz" -T /dev/null
printf '{"attachmentRefs": []}\n' > "$temp/no-audit.json"
reject() {
  local expected=$1
  shift
  : > "$TEST_LOG"
  if bash "$@" > "$temp/output" 2>&1; then echo "Unexpected success: $*" >&2; exit 1; fi
  grep -q "$expected" "$temp/output" || { cat "$temp/output" >&2; exit 1; }
  [[ ! -s $TEST_LOG ]] || { cat "$TEST_LOG" >&2; exit 1; }
}

reject 'Import requires approved private config' "$here/../import.sh" "$sha" "$temp/no.dump" "$temp/no.tar.gz" "$temp/no-audit.json"
mkdir -p /opt/news-hot/shared
: > /opt/news-hot/shared/.env
reject 'Successful restore rehearsal is required' "$here/../import.sh" "$sha" "$temp/no.dump" "$temp/no.tar.gz" "$temp/no-audit.json"
touch /opt/news-hot/shared/initialized
reject 'Import requires approved private config' "$here/../import.sh" "$sha" "$temp/no.dump" "$temp/no.tar.gz" "$temp/no-audit.json"
if bash "$here/../rehearse.sh" "$sha" "$temp/no.dump" "$temp/no.tar.gz" "$temp/no-audit.json" > "$temp/output" 2>&1; then echo 'Missing release permitted rehearsal' >&2; exit 1; fi
[[ ! -s $TEST_LOG ]]

# Public-key validation and existing-account check must precede all provisioning.
cat > "$temp/bin/ssh-keygen" <<'KEYGEN'
#!/usr/bin/env bash
exit 0
KEYGEN
cat > "$temp/bin/id" <<'ID'
#!/usr/bin/env bash
exit 0
ID
/bin/chmod +x "$temp/bin/ssh-keygen" "$temp/bin/id"
printf 'ssh-ed25519 fixture-public-key\n' > "$temp/key.pub"
reject 'Deployment account or directory already exists' "$here/../provision.sh" "$temp/key.pub"
printf '%s\n' '-----BEGIN OPENSSH PRIVATE KEY-----' > "$temp/private-key"
reject 'Expected one Ed25519 public key' "$here/../provision.sh" "$temp/private-key"
cat > "$temp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_LOG"
exit 97
DOCKER
/bin/chmod +x "$temp/bin/docker"
: > "$TEST_LOG"
if bash "$here/../ci-smoke.sh" "$sha" > "$temp/output" 2>&1; then echo 'Missing database image permitted smoke' >&2; exit 1; fi
[[ $(wc -l < "$TEST_LOG") == 1 && $(cat "$TEST_LOG") == 'image inspect --format {{.Id}} postgres:18-alpine' ]] || { cat "$TEST_LOG" >&2; exit 1; }
echo '7 bootstrap early-rejection scenarios passed; no Docker mutations or system mutation commands ran'
