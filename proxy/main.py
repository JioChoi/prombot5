"""Generic streaming HTTP forward proxy for Hugging Face Spaces.

Client sends the real request to this server with two extra headers:
    X-Proxy-Url: https://api.example.com/some/path?q=1
    X-Proxy-Key: <shared secret>
Everything else (method, body, headers incl. Authorization) is forwarded as-is,
and the upstream response is streamed straight back.
"""

import ipaddress
import os
import socket
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

KEYS = {k for k in os.environ.get("PROXY_KEY", "").split(",") if k}

# Headers that describe *this* hop and must not be forwarded in either direction.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
# Set by the caller for us, plus infra headers that would leak/confuse upstream.
# The x-forwarded-*/cf-* family is stamped by the Space's ingress and carries the
# caller's real IP: forwarding it would hand upstream the exact address this relay exists to hide.
DROP_REQUEST = HOP_BY_HOP | {
    "x-proxy-url", "x-proxy-key", "host", "content-length",
    "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port",
    "x-real-ip", "forwarded", "via", "cf-connecting-ip", "cf-ipcountry", "cf-ray",
    "cf-visitor", "cdn-loop", "x-request-id", "x-amzn-trace-id",
}

client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=20.0, read=None, write=None, pool=None),
    follow_redirects=False,
    limits=httpx.Limits(max_connections=200),
)

app = FastAPI()


def blocked_target(url: str) -> str | None:
    """Return an error string if url is unusable or points at a private address."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "X-Proxy-Url must be an absolute http(s) URL"
    try:
        infos = socket.getaddrinfo(parts.hostname, None)
    except socket.gaierror:
        return "cannot resolve target host"
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            return "target resolves to a non-public address"
    return None


@app.get("/")
async def health():
    return {"ok": True, "keys_configured": len(KEYS)}


@app.api_route(
    "/proxy",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
)
async def proxy(request: Request):
    if not KEYS:
        return JSONResponse({"error": "PROXY_KEY not configured"}, status_code=503)
    if request.headers.get("x-proxy-key") not in KEYS:
        return JSONResponse({"error": "bad or missing X-Proxy-Key"}, status_code=401)

    url = request.headers.get("x-proxy-url")
    if not url:
        return JSONResponse({"error": "missing X-Proxy-Url"}, status_code=400)
    if err := blocked_target(url):
        return JSONResponse({"error": err}, status_code=403)

    headers = [
        (k, v) for k, v in request.headers.raw
        if k.decode("latin-1").lower() not in DROP_REQUEST
    ]

    upstream = client.build_request(
        request.method,
        url,
        headers=headers,
        content=request.stream(),  # streamed: never buffers the upload in memory
    )
    try:
        resp = await client.send(upstream, stream=True)
    except httpx.HTTPError as e:
        return JSONResponse({"error": f"upstream request failed: {e}"}, status_code=502)

    out = [
        (k, v) for k, v in resp.headers.multi_items()
        if k.lower() not in HOP_BY_HOP
    ]

    async def body():
        try:
            # aiter_raw: pass compressed bytes through untouched, content-encoding stays valid
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()

    return StreamingResponse(body(), status_code=resp.status_code, headers=dict(out))
