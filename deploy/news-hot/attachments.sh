#!/usr/bin/env bash
# Sourced by first-import scripts; archives contain only regular files and directories.
validate_attachments() {
  local archive=$1 paths
  paths=$(tar -tzf "$archive") || return 1
  if printf '%s\n' "$paths" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then return 1; fi
  if printf '%s\n' "$paths" | grep -Ev '^(uploads|feedback-screenshots)(/|$)|^$' | grep -q .; then
    echo 'Unexpected attachment archive member' >&2; return 1
  fi
  if tar -tvzf "$archive" | grep -Ev '^[-d]' | grep -q .; then
    echo 'Attachment archive contains links or special files' >&2; return 1
  fi
}
