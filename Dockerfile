# One service serving both halves: the built site and /api from the same origin,
# which is what removes CORS and the preflight before every generation.
#
# Two stages because the build needs Node and the runtime needs Python, and
# Render's native runtimes only give you one of the two.

FROM node:22-slim AS web
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# VITE_API and VITE_DATA come from frontend/.env, which is committed: the API is
# same-origin now, and the index lives on Hugging Face either way.
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=web /app/dist ./static
ENV STATIC_DIR=/app/static

# --forwarded-allow-ips: Render terminates TLS and proxies, so the peer address
# is always its edge. Nothing here keys on the client IP any more, so trusting
# the forwarded header costs nothing.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8090} \
    --proxy-headers --forwarded-allow-ips="*"
