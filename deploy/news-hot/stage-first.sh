#!/usr/bin/env bash
set -euo pipefail
umask 077
sha=${1:?Full approved commit SHA}
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 2
root=/opt/news-hot
bundle=$root/incoming/$sha
release=$root/releases/$sha
tool=$(cd "$(dirname "$0")" && pwd)/manifest.cjs
[[ -d $root/shared && ! -e $root/shared/initialized && ! -e $root/current ]] || { echo 'Only a fresh approved deployment can be staged' >&2; exit 1; }
exec 9>"$root/shared/release.lock"
flock -x 9
node "$tool" verify "$sha" "$bundle"
[[ ! -e $release ]] || { echo 'Release already staged; inspect and verify it instead of overwriting' >&2; exit 1; }
tar -tzf "$bundle/source.tar.gz" > "$bundle/source-paths.txt"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$bundle/source-paths.txt"; then exit 1; fi
mkdir -p "$release"
tar -xzf "$bundle/source.tar.gz" -C "$release"
cp "$bundle/release.json" "$release/release.json"
node "$tool" verify "$sha" "$bundle" "$release"
gzip -dc "$bundle/app-image.tar.gz" | docker load
gzip -dc "$bundle/db-image.tar.gz" | docker load
[[ $(docker image inspect --format '{{.Id}}' "news-hot:$sha") == "$(node "$tool" get "$bundle/release.json" appId)" ]] || exit 1
docker image inspect "$(node "$tool" get "$bundle/release.json" dbId)" > /dev/null
echo 'Verified first release staged. No database was created or changed.'
