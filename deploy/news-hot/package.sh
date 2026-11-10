#!/usr/bin/env bash
set -euo pipefail
# Run on a GitHub-hosted runner after the existing check and docker jobs succeed.
sha=${1:?Full commit SHA}
bundle=${2:?Output directory outside the source checkout}
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ $(git rev-parse HEAD) == "$sha" ]] || { echo 'Checkout differs from requested release' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=normal) ]] || { echo 'Release checkout must be clean' >&2; exit 1; }
bundle=$(realpath -m "$bundle")
checkout=$(git rev-parse --show-toplevel)
[[ $bundle != "$checkout" && $bundle != "$checkout/"* ]] || { echo 'Bundle output must be outside the checkout' >&2; exit 1; }
mkdir -p "$bundle"
git archive --format=tar.gz --output="$bundle/source.tar.gz" "$sha"
docker build -t "news-hot-base:$sha" .
docker build --build-arg "APP_BASE=news-hot-base:$sha" -f deploy/news-hot/Dockerfile -t "news-hot:$sha" .
docker pull postgres:18-alpine
docker save "news-hot:$sha" | gzip > "$bundle/app-image.tar.gz"
docker save postgres:18-alpine | gzip > "$bundle/db-image.tar.gz"
app_id=$(gzip -dc "$bundle/app-image.tar.gz" | tar -xOf - manifest.json | node deploy/news-hot/manifest.cjs image-config-id "news-hot:$sha")
db_id=$(gzip -dc "$bundle/db-image.tar.gz" | tar -xOf - manifest.json | node deploy/news-hot/manifest.cjs image-config-id postgres:18-alpine)
node deploy/news-hot/manifest.cjs create "$sha" "$bundle" "$PWD" "$app_id" "$db_id"
node deploy/news-hot/manifest.cjs verify "$sha" "$bundle" "$PWD"
