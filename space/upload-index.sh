#!/bin/sh
# One-time (and after every build_index.py run): put the index where the Space
# build and the browser can each get their half.
#
#   Jio7/prombot-index  (dataset)  the 1.1 GB the Dockerfile bakes in
#   Jio7/Prombot        (model)    the few MB the browser range-reads, which is
#                                  what VITE_DATA in frontend/.env points at
set -e
cd "$(dirname "$0")/../frontend/public"
export HF_HUB_ENABLE_HF_TRANSFER=1

hf repo create Jio7/prombot-index --repo-type dataset --exist-ok
hf upload Jio7/prombot-index . --repo-type dataset \
    --include postings.bin prompts.bin prompts.idx prompts.json tag-dict.csv.gz

hf upload Jio7/Prombot . \
    --include tag-dict.csv.gz tag-groups.csv.gz tags.csv.gz
