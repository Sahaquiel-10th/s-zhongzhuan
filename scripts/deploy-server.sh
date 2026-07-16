#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/super-relay"
REPOSITORY="https://github.com/Sahaquiel-10th/s-zhongzhuan.git"
SOURCE_ARCHIVE="https://codeload.github.com/Sahaquiel-10th/s-zhongzhuan/tar.gz/refs/heads/main"
NODE_IMAGE_SOURCE="${NODE_IMAGE_SOURCE:-mirror.ccs.tencentyun.com/library/node:24-alpine}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://118.195.247.117}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@super-relay.local}"

sudo mkdir -p "$APP_DIR"
sudo chown "$(id -un):$(id -gn)" "$APP_DIR"

download_archive() {
  local archive env_backup
  archive="$(mktemp)"
  env_backup=""
  curl --fail --location --retry 3 "$SOURCE_ARCHIVE" --output "$archive"
  if [[ -f "$APP_DIR/.env" ]]; then
    env_backup="$(mktemp)"
    cp "$APP_DIR/.env" "$env_backup"
  fi
  find "$APP_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar -xzf "$archive" -C "$APP_DIR" --strip-components=1
  if [[ -n "$env_backup" ]]; then
    mv "$env_backup" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
  fi
  rm -f "$archive"
}

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only || download_archive
elif ! git clone "$REPOSITORY" "$APP_DIR"; then
  download_archive
fi

cd "$APP_DIR"
if [[ ! -f .env ]]; then
  session_secret="$(openssl rand -hex 32)"
  encryption_key="$(openssl rand -base64 32)"
  admin_password="$(openssl rand -hex 12)"
  cat > .env <<EOF
NODE_ENV=production
PORT=4173
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
DATABASE_PATH=/app/data/super-relay.db
SESSION_SECRET=$session_secret
UPSTREAM_KEY_ENCRYPTION_KEY=$encryption_key
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$admin_password
RESERVATION_OUTPUT_TOKENS=2048
EOF
  chmod 600 .env
  printf '%s' "$admin_password" > "$HOME/super-relay-admin-password.txt"
  chmod 600 "$HOME/super-relay-admin-password.txt"
fi

sudo docker pull "$NODE_IMAGE_SOURCE"
if [[ "$NODE_IMAGE_SOURCE" != "node:24-alpine" ]]; then
  sudo docker tag "$NODE_IMAGE_SOURCE" node:24-alpine
fi

sudo docker-compose down
sudo docker-compose up --build -d

sudo tee /etc/nginx/sites-available/super-relay >/dev/null <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
NGINX

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/super-relay /etc/nginx/sites-enabled/super-relay
sudo nginx -t
sudo systemctl reload nginx

echo "DEPLOY_DONE"
echo "URL=$PUBLIC_BASE_URL"
echo "ADMIN_EMAIL=$ADMIN_EMAIL"
echo "ADMIN_PASSWORD=$(cat "$HOME/super-relay-admin-password.txt")"
sudo docker-compose ps
