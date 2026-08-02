"""Send a request through one of the HF relays, trying others if one is down.

Env (see .env):
    PROXY_URLS  comma-separated relay origins
    PROXY_KEY   shared secret matching the relays
"""

import os
import random

import httpx

URLS = [u.strip().rstrip("/") for u in os.environ.get("PROXY_URLS", "").split(",") if u.strip()]
KEY = os.environ.get("PROXY_KEY", "")

# read=None: image generation holds the connection open for a long time.
client = httpx.AsyncClient(timeout=httpx.Timeout(connect=30.0, read=None, write=None, pool=None))


async def send(method: str, url: str, stream: bool = False, **kwargs) -> httpx.Response:
    """httpx.request, routed through a relay. Falls back to the next one on failure.

    Free Spaces sleep and occasionally land in RUNTIME_ERROR, so a dead relay is
    the expected case, not the exceptional one — that redundancy is the whole
    reason for running more than one.

    With stream=True the body is left unread, so the caller must iterate it and
    close it. That is what makes NovelAI's progress images arrive as they are
    produced rather than all at once at the end.
    """
    async def one(target: str, **kw) -> httpx.Response:
        if not stream:
            return await client.request(method, target, **kw)
        # Status and headers are available before the body, which is what lets the
        # 502 check below run without pulling the stream.
        return await client.send(client.build_request(method, target, **kw), stream=True)

    if not URLS:
        return await one(url, **kwargs)  # unconfigured: go direct

    headers = {**kwargs.pop("headers", {}), "X-Proxy-Key": KEY, "X-Proxy-Url": url}
    last = None
    for base in random.sample(URLS, len(URLS)):
        try:
            r = await one(base + "/proxy", headers=headers, **kwargs)
            # 502 is the relay reporting its own upstream failure; try another.
            # Anything else (including 401 from NovelAI) is a real answer.
            if r.status_code != 502:
                return r
            if stream:
                await r.aclose()
            last = httpx.HTTPError(f"{base} returned 502")
        except httpx.HTTPError as e:
            last = e
    raise last
