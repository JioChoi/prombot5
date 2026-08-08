"""One round trip against the real database: save, list, overwrite, rename, delete.

    python backend/test_presets.py

Uses a throwaway token, so it writes under an owner id no person has, and clears
up after itself. Run it after any change to the SQL — a preset that saves but
does not come back is the failure this is here to catch.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

AUTH = {"Authorization": "Bearer test-token-not-a-real-key"}
client = TestClient(app)


def names():
    r = client.get("/api/presets", headers=AUTH)
    assert r.status_code == 200, r.text
    return [p["name"] for p in r.json()]


def main():
    # Whatever a previous failed run left behind.
    for n in names():
        client.delete(f"/api/presets/{n}", headers=AUTH)
    assert names() == [], "test owner should start empty"

    # No key, no presets — the owner id is the key, so this must not be optional.
    assert client.get("/api/presets").status_code == 401

    r = client.put("/api/presets/Night portraits", headers=AUTH, json={"config": '{"steps":28}'})
    assert r.status_code == 200, r.text
    assert names() == ["Night portraits"]

    # Same name again is an overwrite, not a second row.
    client.put("/api/presets/Night portraits", headers=AUTH, json={"config": '{"steps":50}'})
    listed = client.get("/api/presets", headers=AUTH).json()
    assert len(listed) == 1, listed
    assert listed[0]["config"] == '{"steps":50}'
    assert listed[0]["created_at"].endswith("Z"), listed[0]["created_at"]

    r = client.patch("/api/presets/Night portraits", headers=AUTH, json={"name": "Daylight"})
    assert r.status_code == 200, r.text
    assert names() == ["Daylight"]

    # Renaming onto a name already in use must not silently eat the other one.
    client.put("/api/presets/Second", headers=AUTH, json={"config": "{}"})
    assert client.patch("/api/presets/Second", headers=AUTH, json={"name": "Daylight"}).status_code == 409
    assert sorted(names()) == ["Daylight", "Second"]

    # Junk in, 400 out — both fields cross a trust boundary.
    assert client.put("/api/presets/   ", headers=AUTH, json={"config": "{}"}).status_code == 400
    assert client.put("/api/presets/x", headers=AUTH, json={"config": 12}).status_code == 400

    for n in names():
        assert client.delete(f"/api/presets/{n}", headers=AUTH).status_code == 204
    assert names() == []
    print("presets: save, list, overwrite, rename, conflict, validation, delete — all pass")


if __name__ == "__main__":
    main()
