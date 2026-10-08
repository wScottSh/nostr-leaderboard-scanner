#!/usr/bin/env bash
# Builds dist/ and ships it plus the nginx site to the droplet.
# One-time HTTPS after DNS points here: ssh "$HOST" certbot --nginx -d qrgo.fyi -d www.qrgo.fyi
set -euo pipefail
HOST="${HOST:-notes-droplet}"
cd "$(dirname "$0")/.."
npm run build
if grep -q '127\.0\.0\.1' dist/app.js; then echo "dist/ has a local relay override; refusing to deploy" >&2; exit 1; fi
ssh "$HOST" 'mkdir -p /var/www/qrgo.fyi/html'
rsync -a --delete dist/ "$HOST:/var/www/qrgo.fyi/html/"
if ! ssh "$HOST" 'test -e /etc/nginx/sites-available/qrgo.fyi'; then
  scp deploy/qrgo.fyi.nginx.conf "$HOST:/etc/nginx/sites-available/qrgo.fyi"
  ssh "$HOST" 'ln -sf /etc/nginx/sites-available/qrgo.fyi /etc/nginx/sites-enabled/qrgo.fyi && nginx -t && systemctl reload nginx'
fi
