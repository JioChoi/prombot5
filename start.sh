#!/bin/sh
# Self-hosted: one uvicorn on 0.0.0.0:8020 serving the built site and /api,
# behind Caddy. Same shape as the Docker image, without the container.
cd "$(dirname "$0")"
set -e

[ "$1" = "--no-build" ] || (cd frontend && npm ci && npm run build)

cd backend
set -a; . ./.env; set +a
export STATIC_DIR="$PWD/../frontend/dist"
exec uvicorn main:app --host 0.0.0.0 --port 8020 \
    --proxy-headers --forwarded-allow-ips="${TRUSTED_PROXY_IPS:-127.0.0.1}"
