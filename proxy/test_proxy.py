"""Self-check: python test_proxy.py  (needs `pip install -r requirements.txt`)"""

import os
import threading
import time

os.environ["PROXY_KEY"] = "k1,k2"

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

import main

# local upstream to forward to
up = FastAPI()


@up.get("/echo")
async def echo(request: Request):
    return {"q": dict(request.query_params), "auth": request.headers.get("authorization"),
            # host/connection/transfer-encoding are legitimately re-set by the new hop;
            # anything carrying the original caller's identity must not survive.
            "leaked": sorted(k for k in request.headers
                             if k.startswith(("x-forwarded", "cf-")) or k in
                             {"x-real-ip", "forwarded", "via", "x-proxy-key", "x-proxy-url"})}


@up.post("/big")
async def big(request: Request):
    n = 0
    async for chunk in request.stream():
        n += len(chunk)
    return StreamingResponse((b"y" * 65536 for _ in range(160)), headers={"X-Got": str(n)})


server = uvicorn.Server(uvicorn.Config(up, host="127.0.0.1", port=8731, log_level="error"))
threading.Thread(target=server.run, daemon=True).start()
while not server.started:
    time.sleep(0.05)

base = "http://127.0.0.1:8731"
hdr = {"X-Proxy-Key": "k1"}

# `with` keeps one event loop for the whole block, so the httpx pool stays valid
with TestClient(main.app) as client:
    assert client.get("/").json()["keys_configured"] == 2
    assert client.get("/proxy", headers={"X-Proxy-Url": base}).status_code == 401
    assert client.get("/proxy", headers={"X-Proxy-Key": "bad", "X-Proxy-Url": base}).status_code == 401
    assert client.get("/proxy", headers={"X-Proxy-Key": "k1"}).status_code == 400
    for bad in ("http://127.0.0.1:8731/echo", "http://localhost:8731/echo",
                "ftp://example.com", "/relative", "http://no-such-host.invalid/x"):
        r = client.get("/proxy", headers={"X-Proxy-Key": "k2", "X-Proxy-Url": bad})
        assert r.status_code == 403, (bad, r.status_code, r.text)

    # 127.0.0.1 is blocked by design, so drop the guard for the forwarding leg
    main.blocked_target = lambda url: None

    r = client.get("/proxy", headers={**hdr, "X-Proxy-Url": f"{base}/echo?a=1&a=2&b=x",
                                      "Authorization": "Bearer secret",
                                      "X-Forwarded-For": "203.0.113.7",  # must not reach upstream
                                      "CF-Connecting-IP": "203.0.113.7"})
    assert r.status_code == 200, r.text
    assert r.json() == {"q": {"a": "2", "b": "x"}, "auth": "Bearer secret", "leaked": []}, r.json()

    payload = b"z" * (12 * 1024 * 1024)  # 12 MiB up
    r = client.post("/proxy", headers={**hdr, "X-Proxy-Url": f"{base}/big"}, content=payload)
    assert r.status_code == 200, r.text
    assert r.headers["x-got"] == str(len(payload)), r.headers["x-got"]
    assert len(r.content) == 160 * 65536, len(r.content)  # 10 MiB down

server.should_exit = True
print("ok")
