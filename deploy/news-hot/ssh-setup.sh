#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${DEPLOY_HOST:-} =~ ^[a-zA-Z0-9.-]+$ && ${DEPLOY_PORT:-} =~ ^[0-9]{1,5}$ && ${DEPLOY_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid deployment SSH variables' >&2; exit 1; }
(( DEPLOY_PORT > 0 && DEPLOY_PORT < 65536 )) || exit 1
[[ -n ${DEPLOY_SSH_KEY:-} && -n ${DEPLOY_KNOWN_HOSTS:-} && -n ${RUNNER_TEMP:-} ]] || { echo 'Missing deployment SSH configuration' >&2; exit 1; }
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$RUNNER_TEMP/news-hot-key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$RUNNER_TEMP/news-hot-known-hosts"
chmod 600 "$RUNNER_TEMP/news-hot-key" "$RUNNER_TEMP/news-hot-known-hosts"
cat >> "$HOME/.ssh/config" <<EOF
Host news-hot-deploy
    HostName $DEPLOY_HOST
    Port $DEPLOY_PORT
    User $DEPLOY_USER
    IdentityFile $RUNNER_TEMP/news-hot-key
    IdentitiesOnly yes
    UserKnownHostsFile $RUNNER_TEMP/news-hot-known-hosts
    StrictHostKeyChecking yes
    BatchMode yes
    ConnectTimeout 15
    ServerAliveInterval 30
    ServerAliveCountMax 3
EOF
