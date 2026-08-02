---
title: Relay
emoji: 🛰️
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Relay

Generic streaming HTTP forward proxy. Not tied to any upstream API.

## Deploy (Hugging Face Space)

1. New Space → SDK **Docker** → blank.
2. Push `Dockerfile`, `requirements.txt`, `main.py`, `README.md`.
3. Settings → Variables and secrets → **Secret** `PROXY_KEY` = a long random string.
   Comma-separated for multiple valid keys (rotate without downtime).
4. Repeat for as many Spaces as you want; the client rotates across them.

Generate a key: `python -c "import secrets; print(secrets.token_urlsafe(32))"`

## Use

```
POST https://<user>-<space>.hf.space/proxy
X-Proxy-Url: https://api.novelai.net/ai/generate-image
X-Proxy-Key: <PROXY_KEY>
Authorization: Bearer <upstream token>
Content-Type: application/json

{"input": "..."}
```

Method, body, and all other headers pass through untouched; the upstream status,
headers, and body stream straight back. Request and response bodies are streamed,
so large uploads/downloads never buffer in memory.

`GET /` is a health check.

## Notes

- Only public IPs are reachable — targets resolving to private/loopback/link-local
  addresses are rejected (403).
- Redirects are **not** followed; the 3xx and its `Location` are returned to the caller.
- Free Spaces sleep after ~48h idle; first request after that pays a cold start.
- Anyone holding `PROXY_KEY` can make this server fetch any public URL. Treat it
  like a credential; rotate by editing the secret.
