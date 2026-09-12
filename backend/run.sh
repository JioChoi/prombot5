#!/bin/sh
# Loads .env (PROXY_URLS, PROXY_KEY) and serves on :8090
#
# INDEX_DIR points at the prompt index the draw endpoint mmaps — postings.bin,
# prompts.bin, prompts.idx, prompts.json, tag-dict.csv.gz. Unset it and the repo
# copy in frontend/public is used; /api/prompt answers 503 if they are missing.
# 8000 is taken by the elemento/diffusion backend.
cd "$(dirname "$0")"
set -a; . ./.env; set +a
# --forwarded-allow-ips is the reverse proxy in front of us and nothing else: the
# rate limiter keys on X-Forwarded-For, so trusting that header from any source
# would let a caller spoof a fresh IP per request and walk straight past it.
exec uvicorn main:app --reload --port 8090 \
    --proxy-headers --forwarded-allow-ips="${TRUSTED_PROXY_IPS:-127.0.0.1}"
