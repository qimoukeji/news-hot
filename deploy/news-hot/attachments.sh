#!/usr/bin/env bash
# Sourced by first-import scripts; archives contain only regular files and directories.
validate_attachments() {
  local archive=$1 paths entries
  paths=$(tar -tzf "$archive") || return 1
  if grep -E '(^/|(^|/)\.\.(/|$))' <<< "$paths" > /dev/null; then return 1; fi
  if grep -Ev '^(uploads|feedback-screenshots)(/|$)|^$' <<< "$paths" > /dev/null; then
    echo 'Unexpected attachment archive member' >&2; return 1
  fi
  # Read tar to completion before matching; early grep exits can hide SIGPIPE with pipefail.
  entries=$(tar -tvzf "$archive") || return 1
  if [[ -n $entries ]] && grep -Ev '^[-d]' <<< "$entries" > /dev/null; then
    echo 'Attachment archive contains links or special files' >&2; return 1
  fi
  return 0
}
