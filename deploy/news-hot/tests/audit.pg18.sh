#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
container=news-hot-audit-test-$(date +%s)-$RANDOM
temp=$(mktemp -d)
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$temp"; }
trap cleanup EXIT
# No ports, external network, credentials, .env files, or business volumes.
docker run -d --name "$container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=audit_test postgres:18-alpine >/dev/null
ready=false
for ((i=0; i<60; i++)); do
  # The entrypoint's temporary init server only listens on a Unix socket.
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d audit_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]] || { echo 'Isolated PostgreSQL 18 did not start' >&2; exit 1; }
docker exec -i "$container" psql -X -U postgres -d audit_test -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE empty_table (id integer, body text);
CREATE TABLE fixture_rows (id integer, body text, amount numeric, occurred_at timestamptz, metadata jsonb, tags text[]);
INSERT INTO fixture_rows VALUES
  (1, 'first value', 1.2300, '2026-10-12T09:00:00+08:00', '{"nested": [1, true, null]}', ARRAY['中文', 'a']),
  (2, 'second value', 0, '2026-10-12T01:00:00Z', '{"text": "quoted value"}', '{}'),
  (3, NULL, NULL, NULL, NULL, NULL);
CREATE SEQUENCE fixture_seq;
SELECT setval('fixture_seq', 41, false);
SQL
docker exec "$container" pg_dump -U postgres -d audit_test -Fc --no-owner > "$temp/source.dump"
docker exec "$container" createdb -U postgres restored_test
docker exec -i "$container" pg_restore -U postgres -d restored_test --no-owner --no-acl --exit-on-error < "$temp/source.dump"
# Share only the network namespace of the network-none test container so the
# real driver can reach its PostgreSQL over loopback.
docker run --rm --network "container:$container" -v "$repo:/workspace:ro" -w /workspace \
  -e TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/audit_test \
  -e TEST_RESTORED_DATABASE_URL=postgres://postgres@127.0.0.1:5432/restored_test \
  node:24-trixie-slim node --test deploy/news-hot/tests/audit.pg18.test.cjs
