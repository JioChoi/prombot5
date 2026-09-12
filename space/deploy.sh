#!/bin/sh
# One-time bootstrap of the Space. The image is a shell — git, deps, index —
# and it clones the backend from GitHub at boot, so this only ever needs to run
# again if Dockerfile or entrypoint.sh changes. Ordinary backend changes go to
# GitHub and the running Space picks them up within POLL_SECONDS.
#
# Needs `hf auth login` as the account that owns the Space (jio777, not Jio7 —
# they are different accounts), or HF_TOKEN in the environment.
#
#     ./deploy.sh [jio777/proxy6]
set -e
cd "$(dirname "$0")"
SPACE="${1:-jio777/proxy6}"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp Dockerfile README.md entrypoint.sh "$STAGE"/

# --delete "*": the Space used to be a relay. Anything from that build that
# this one does not overwrite would otherwise sit in the image forever.
hf upload "$SPACE" "$STAGE" . --repo-type space --delete "*" \
    --commit-message "backend: follow github"
echo "pushed to https://huggingface.co/spaces/$SPACE"
