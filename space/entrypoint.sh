#!/bin/sh
# Clone the backend from GitHub, then follow it: every POLL_SECONDS, ask the
# remote for the tip of the branch and hard-reset onto it if it moved.
#
# Nothing restarts the process on a new commit — uvicorn --reload does that
# itself. watchfiles is already watching the working tree, so `git reset` is
# both the deploy and the trigger, and the reload is the same one that happens
# in dev. In-flight generations die on a reload; that is true of any restart.
set -e

REPO="${REPO_URL:-https://github.com/JioChoi/prombot5}"
BRANCH="${REPO_BRANCH:-main}"
SRC=/src

[ -d "$SRC/.git" ] || git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"

follow() {
    while sleep "${POLL_SECONDS:-60}"; do
        # Every failure here is transient by assumption — GitHub unreachable, a
        # force-push mid-fetch. Keep serving the commit we have and ask again.
        git -C "$SRC" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 || continue
        [ "$(git -C "$SRC" rev-parse HEAD)" = "$(git -C "$SRC" rev-parse FETCH_HEAD)" ] && continue

        # requirements before the code: reloading onto a commit that imports a
        # package this image does not have is a crash loop, not a deploy.
        if ! git -C "$SRC" diff --quiet HEAD FETCH_HEAD -- backend/requirements.txt; then
            git -C "$SRC" show FETCH_HEAD:backend/requirements.txt > /tmp/req.txt \
                && pip install --no-cache-dir -q -r /tmp/req.txt || continue
        fi

        echo "deploy: $(git -C "$SRC" rev-parse --short FETCH_HEAD)"
        git -C "$SRC" reset --hard --quiet FETCH_HEAD
    done
}
follow &

cd "$SRC/backend"
# --forwarded-allow-ips="*": the Space always sits behind Hugging Face's edge,
# so the peer address is never the client. Nothing keys on the client IP — the
# draw limiter buckets by sha256 of the caller's NovelAI key — so trusting the
# forwarded header costs nothing here.
exec uvicorn main:app --host 0.0.0.0 --port 7860 --reload --reload-dir "$SRC/backend" \
    --proxy-headers --forwarded-allow-ips="*"
