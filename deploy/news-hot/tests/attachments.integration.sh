#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../attachments.sh"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/data/uploads" "$temp/data/feedback-screenshots" "$temp/data/other"
printf 'image bytes\n' > "$temp/data/uploads/regular.png"
expect_reject() { if validate_attachments "$1" > "$temp/output" 2>&1; then echo "Unexpected archive accepted: $1" >&2; exit 1; fi; }
tar -czf "$temp/empty.tar.gz" -T /dev/null
validate_attachments "$temp/empty.tar.gz"
tar -czf "$temp/regular.tar.gz" -C "$temp/data" uploads feedback-screenshots
validate_attachments "$temp/regular.tar.gz"
tar -czf "$temp/other.tar.gz" -C "$temp/data" other
expect_reject "$temp/other.tar.gz"
tar -czf "$temp/traversal.tar.gz" --transform='s|uploads/regular.png|uploads/../secret|' -C "$temp/data" uploads/regular.png
expect_reject "$temp/traversal.tar.gz"
ln -s regular.png "$temp/data/uploads/link.png"
tar -czf "$temp/link.tar.gz" -C "$temp/data" uploads
expect_reject "$temp/link.tar.gz"
rm "$temp/data/uploads/link.png"
ln -s missing.png "$temp/data/uploads/dangling.png"
tar -czf "$temp/dangling.tar.gz" -C "$temp/data" uploads
expect_reject "$temp/dangling.tar.gz"
rm "$temp/data/uploads/dangling.png"
mkfifo "$temp/data/uploads/pipe"
tar -czf "$temp/pipe.tar.gz" -C "$temp/data" uploads
expect_reject "$temp/pipe.tar.gz"
echo '7 attachment archive scenarios passed'
