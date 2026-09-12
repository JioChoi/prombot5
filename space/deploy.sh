#!/bin/sh
# One-time bootstrap of the Space. The image is a shell — git, deps, index —
# and it clones the backend from GitHub at boot, so this only ever needs to run
# again if Dockerfile or entrypoint.sh changes. Ordinary backend changes go to
# GitHub and the running Space picks them up within POLL_SECONDS.
#
# Needs `hf auth login` as the account that owns the Space (jio777, not Jio7 —
# they are different accounts), or HF_TOKEN in the environment.
#
#     ./deploy.sh [Jio777/proxy4]
set -e
cd "$(dirname "$0")"
SPACE="${1:-Jio777/proxy4}"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp Dockerfile README.md entrypoint.sh "$STAGE"/

# upload_folder, not `hf upload`: the CLI calls create_repo first, and creating
# a Docker Space now answers 402 without PRO even when the Space already exists.
#
# delete_patterns: the Space used to be a relay. Anything from that build this
# one does not overwrite would otherwise sit in the image forever.
python3 - "$SPACE" "$STAGE" <<'PY'
import sys
from huggingface_hub import HfApi
space, stage = sys.argv[1], sys.argv[2]
HfApi().upload_folder(repo_id=space, repo_type="space", folder_path=stage,
                      delete_patterns="*", commit_message="backend: follow github")
PY
echo "pushed to https://huggingface.co/spaces/$SPACE"
