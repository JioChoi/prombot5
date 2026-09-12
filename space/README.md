---
title: Prombot API
emoji: 🎨
colorFrom: pink
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Prombot API

The backend half of prombot: `/api/*` only. The site lives on GitHub Pages at
https://prombot.net and calls this origin cross-origin, which is why
`ALLOWED_ORIGINS` matters here and did not on the single-service deploy.

The backend source is not in this Space. The image carries git, the
dependencies and the index; `entrypoint.sh` clones
https://github.com/JioChoi/prombot5 at boot, polls the branch every
`POLL_SECONDS`, and hard-resets onto a new commit — `uvicorn --reload` sees the
files change and restarts itself. So pushing to GitHub is the deploy, and
nothing here has a Hugging Face token.

`./space/deploy.sh` bootstraps this Space, and is needed again only when
`Dockerfile` or `entrypoint.sh` changes.

## Secrets (Settings → Variables and secrets)

| Name | Kind | Value |
| --- | --- | --- |
| `PROXY_URLS` | secret | the remaining relay Spaces, comma separated |
| `PROXY_KEY` | secret | shared secret matching those relays |
| `DATABASE_URL` | secret | `mysql://user:pass@host:port/db` for presets |
| `ALLOWED_ORIGINS` | variable | `https://prombot.net,https://www.prombot.net` |
| `POLL_SECONDS` | variable | how often to check GitHub; default 60 |
| `REPO_URL` / `REPO_BRANCH` | variable | override what to follow; default the repo above on `main` |

`PROXY_URLS` must not list this Space. It was one of the relays; it is not one
any more, and a relay that points at itself is a loop.

## Health

`GET /health` → `{"ok": true, "relays": N}`.
