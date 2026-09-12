# Backend-only image for a Hugging Face Space. The site is not in here: it is
# built by .github/workflows/pages.yml and served from GitHub Pages, so this
# process answers /api and nothing else (STATIC_DIR stays unset).
#
# The backend source is not in here either. The image is a shell — git, the
# dependencies and the index — and entrypoint.sh clones the GitHub repo at boot
# and follows it from then on. Pushing to GitHub is the whole deploy; this Space
# is pushed to once, when it is created.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The index is baked into the image rather than fetched at boot: a free Space
# sleeps after ~48h idle, and a 1.1 GB download on every cold start would be
# paid by whoever happens to open the site first.
RUN pip install --no-cache-dir "huggingface_hub[hf_transfer]"
ENV HF_HUB_ENABLE_HF_TRANSFER=1
ARG INDEX_REPO=Jio7/prombot-index
RUN hf download "$INDEX_REPO" --repo-type dataset --local-dir /index \
        postings.bin prompts.bin prompts.idx prompts.json tag-dict.csv.gz \
    && rm -rf /index/.cache /root/.cache/huggingface

# Installed at build from the repo's own list, so a normal boot installs
# nothing. entrypoint.sh reinstalls only when a commit changes this file.
ARG REPO_RAW=https://raw.githubusercontent.com/JioChoi/prombot5/main
ADD $REPO_RAW/backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY entrypoint.sh /entrypoint.sh
# chmod: the Hub does not carry the exec bit through an upload, and a CMD that
# is not executable fails with nothing in the logs to say why.
RUN chmod +x /entrypoint.sh
# Unbuffered, or a crash in the first seconds takes its own traceback with it.
ENV INDEX_DIR=/index PYTHONUNBUFFERED=1
CMD ["/entrypoint.sh"]
