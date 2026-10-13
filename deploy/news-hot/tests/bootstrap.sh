#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
docker run --rm --network none -v "$repo:/workspace:ro" -w /workspace \
  -e NEWSHOT_TEST_ISOLATED=true node:24-trixie-slim \
  bash deploy/news-hot/tests/bootstrap.integration.sh
