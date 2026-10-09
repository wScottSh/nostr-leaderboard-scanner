#!/usr/bin/env bash
# Builds dist/ and ships it plus the nginx site to the droplet, then the
# finalizer: one bundled file (no npm install there) run by a systemd timer.
# One-time HTTPS after DNS points here: ssh "$HOST" certbot --nginx -d qrgo.fyi -d www.qrgo.fyi
set -euo pipefail
HOST="${HOST:-notes-droplet}"
cd "$(dirname "$0")/.."
npm run build
if grep -q '127\.0\.0\.1' dist/app.js; then echo "dist/ has a local relay or calendar override; refusing to deploy" >&2; exit 1; fi
ssh "$HOST" 'mkdir -p /var/www/qrgo.fyi/html'
rsync -a --delete dist/ "$HOST:/var/www/qrgo.fyi/html/"
if ! ssh "$HOST" 'test -e /etc/nginx/sites-available/qrgo.fyi'; then
  scp deploy/qrgo.fyi.nginx.conf "$HOST:/etc/nginx/sites-available/qrgo.fyi"
  ssh "$HOST" 'ln -sf /etc/nginx/sites-available/qrgo.fyi /etc/nginx/sites-enabled/qrgo.fyi && nginx -t && systemctl reload nginx'
fi

npm run build:finalizer
ssh "$HOST" 'mkdir -p /opt/qrgo-finalizer && (id qrgo >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin qrgo)'
rsync -a --chmod=F644 dist-finalizer/finalizer.mjs "$HOST:/opt/qrgo-finalizer/finalizer.mjs"
reload=
for unit in qrgo-finalizer.service qrgo-finalizer.timer; do
  if ! ssh "$HOST" "cmp -s - /etc/systemd/system/$unit" < "deploy/$unit"; then
    scp "deploy/$unit" "$HOST:/etc/systemd/system/$unit"
    reload=1
  fi
done
if [ -n "$reload" ]; then ssh "$HOST" 'systemctl daemon-reload'; fi
ssh "$HOST" 'systemctl enable --now qrgo-finalizer.timer'
