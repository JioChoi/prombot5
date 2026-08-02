"""Send requests through one of the relay Spaces.

Env:
    PROXY_URLS  comma-separated, e.g. https://a.hf.space,https://b.hf.space
    PROXY_KEY   shared secret matching the Spaces
"""

import os
import random

import httpx

URLS = [u.strip().rstrip("/") for u in os.environ.get("PROXY_URLS", "").split(",") if u.strip()]
KEY = os.environ.get("PROXY_KEY", "")

_client = httpx.AsyncClient(timeout=httpx.Timeout(connect=30.0, read=None, write=None, pool=None))


def request(method: str, url: str, **kwargs) -> httpx.Response:
    """Same signature as httpx.request, but routed through a random relay.

    Returns an awaitable; use `stream=True` via client.send if you need streaming.
    """
    if not URLS:
        return _client.request(method, url, **kwargs)  # no relays configured: go direct
    headers = {**kwargs.pop("headers", {}), "X-Proxy-Url": url, "X-Proxy-Key": KEY}
    # ponytail: uniform random pick. Swap for least-errors/round-robin if one Space
    # starts getting rate-limited more than the others.
    return _client.request(method, random.choice(URLS) + "/proxy", headers=headers, **kwargs)
