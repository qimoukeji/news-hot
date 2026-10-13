#!/usr/bin/env bash
set -euo pipefail
umask 077
# Review and approve this system configuration before running as root.
public_key=${1:?Public key file only; keep the private key on the operator machine}
[[ $EUID == 0 ]] || { echo 'Provisioning requires root' >&2; exit 1; }
ssh-keygen -lf "$public_key" > /dev/null
[[ $(wc -l < "$public_key") == 1 && $(head -c 12 "$public_key") == ssh-ed25519\  ]] || { echo 'Expected one Ed25519 public key' >&2; exit 1; }
if id news-hot-deploy >/dev/null 2>&1 || [[ -e /opt/news-hot ]]; then
  echo 'Deployment account or directory already exists; inspect instead of overwriting' >&2; exit 1
fi
getent group docker > /dev/null
useradd --create-home --shell /bin/bash --groups docker news-hot-deploy
install -d -m 700 -o news-hot-deploy -g news-hot-deploy /home/news-hot-deploy/.ssh
# Actions only needs remote commands and transfers, never agent forwarding or SSH tunnels.
{ printf 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty '; cat "$public_key"; } > /home/news-hot-deploy/.ssh/authorized_keys
chown news-hot-deploy:news-hot-deploy /home/news-hot-deploy/.ssh/authorized_keys
chmod 600 /home/news-hot-deploy/.ssh/authorized_keys
install -d -m 700 -o news-hot-deploy -g news-hot-deploy /opt/news-hot /opt/news-hot/shared /opt/news-hot/incoming /opt/news-hot/releases /opt/news-hot/backups
echo 'Account and directories prepared. Private runtime configuration and approved import are still required.'
