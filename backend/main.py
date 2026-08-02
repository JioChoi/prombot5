"""Backend the browser talks to. Adds the CORS headers NovelAI won't, and spreads
outbound calls across the relays.

The browser cannot call api.novelai.net directly (its allowlist only admits
novelai.net and localhost) and it cannot call the relays directly either — those
pass NovelAI's response headers through verbatim, CORS denial included. So the
browser talks here, and here talks to the relays.
"""

import os

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

import relay

# Not api.novelai.net: that host rejects persistent (pst-) API keys outright, answering
# "Please refresh NovelAI.net. If using a third-party tool, update to the image URL."
# on every path — subscription checks included, not just generation.
NAI = "https://image.novelai.net"
# The frontend calls this backend cross-origin in both dev and prod (frontend/.env
# points it here), so this list is load-bearing, not a fallback. A dev box reached by
# LAN IP or any other host needs its origin added via ALLOWED_ORIGINS.
ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:8092,https://prombot.net,https://www.prombot.net,https://shoujo.jio.is",
).split(",")]

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.get("/health")
async def health():
    return {"ok": True, "relays": len(relay.URLS)}


@app.get("/api/subscription")
async def subscription(request: Request):
    """Cheap authenticated call — used to validate a pasted API key."""
    auth = request.headers.get("authorization", "")
    try:
        r = await relay.send("GET", f"{NAI}/user/subscription", headers={"Authorization": auth})
    except httpx.HTTPError as e:
        return JSONResponse({"error": f"all relays failed: {e}"}, status_code=503)
    return JSONResponse(r.json(), status_code=r.status_code)


async def forward(request: Request, path: str):
    """Pipes the generation payload upstream and the response straight back.

    Nothing here may buffer: on the streaming path NovelAI emits a progress image
    every few steps, and the point is that the browser sees each one as it lands.
    """
    auth = request.headers.get("authorization", "")
    try:
        r = await relay.send("POST", f"{NAI}{path}", stream=True,
                             headers={"Authorization": auth}, content=await request.body())
    except httpx.HTTPError as e:
        return JSONResponse({"error": f"all relays failed: {e}"}, status_code=503)

    async def body():
        try:
            # aiter_raw: hand the bytes on exactly as they arrive, so a
            # content-encoding the relay passed through stays valid.
            async for chunk in r.aiter_raw():
                yield chunk
        finally:
            await r.aclose()

    # Content-Encoding would be a lie about bytes we are not re-encoding, and
    # Content-Length cannot be known while streaming.
    keep = {"content-type", "content-encoding"}
    return StreamingResponse(
        body(),
        status_code=r.status_code,
        headers={k: v for k, v in r.headers.items() if k.lower() in keep},
    )


@app.post("/api/generate-image")
async def generate_image(request: Request):
    """One zip at the end."""
    return await forward(request, "/ai/generate-image")


@app.post("/api/generate-image-stream")
async def generate_image_stream(request: Request):
    """Progress images as they are produced. Needs "stream": "msgpack" in the
    payload — the plain endpoint ignores that flag and answers with a zip."""
    return await forward(request, "/ai/generate-image-stream")
