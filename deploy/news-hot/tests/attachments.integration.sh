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
# Listings exceed pipe buffers, so every validation must still inspect all members.
mkdir -p "$temp/large/uploads"
for ((i=0; i<5000; i++)); do
  printf 'attachment bytes\n' > "$temp/large/uploads/file-$i.png"
done
tar -czf "$temp/large-regular.tar.gz" -C "$temp/large" uploads
validate_attachments "$temp/large-regular.tar.gz"

ln -s /tmp "$temp/large/link"
for ((i=0; i<5000; i++)); do printf 'link\n'; done > "$temp/link-paths"
tar -czf "$temp/large-links.tar.gz" --transform='s|^link$|uploads/link|' -C "$temp/large" -T "$temp/link-paths"
expect_reject "$temp/large-links.tar.gz"

tar -czf "$temp/large-other.tar.gz" --transform='s|^uploads|other|' -C "$temp/large" uploads
expect_reject "$temp/large-other.tar.gz"

tar -czf "$temp/large-traversal.tar.gz" --transform='s|^uploads|uploads/../outside|' -C "$temp/large" uploads
expect_reject "$temp/large-traversal.tar.gz"

tar -czf "$temp/large-absolute.tar.gz" --transform='s|^uploads|/uploads|' -C "$temp/large" uploads
expect_reject "$temp/large-absolute.tar.gz"

printf 'not a gzip archive\n' > "$temp/corrupt.tar.gz"
expect_reject "$temp/corrupt.tar.gz"

echo '13 attachment archive scenarios passed'
