"""Saved presets — one row per (owner, name). Schema in schema.sql.

The owner id is sha256 of the caller's NovelAI token, computed here and never
accepted from the client: an id the browser could name is an id anyone could
name, and presets would be readable by guessing. The cost of having no accounts
is that rotating the key means a new owner id and an empty list.

The handlers are plain `def`, not `async def` — the MySQL driver is synchronous,
so FastAPI runs them in its threadpool and one slow query cannot stall the event
loop that the generation stream lives on.
"""

import hashlib
import os
from urllib.parse import unquote, urlparse

import pymysql
from fastapi import APIRouter, HTTPException, Request
from pymysql.constants import CLIENT

router = APIRouter(prefix="/api/presets")

# One variable holds the whole connection, in the form Aiven hands out:
#   mysql://user:password@host:port/defaultdb
DB_URL = os.environ.get("DATABASE_URL", "")
# Aiven's CA, if you downloaded it. Without one the connection is still
# encrypted, just not checked against a known issuer.
DB_CA = os.environ.get("DATABASE_CA") or None

# A name has to fit a row and a config has to fit a prompt — both arrive from the
# browser, so both are capped before they reach the insert.
MAX_NAME = 100
MAX_CONFIG = 200_000


def owner(request: Request) -> str:
    """Who is asking, as a hash of their key. Raises before any DB work."""
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Log in with your NovelAI key to use presets")
    return hashlib.sha256(token.encode()).hexdigest()


# ponytail: one connection per request, no pool. Presets are a few calls per
# session next to the generation traffic; add DBUtils/a pool if that changes.
def connect():
    if not DB_URL:
        raise HTTPException(503, "Presets are offline: DATABASE_URL is not set")
    u = urlparse(DB_URL)
    try:
        return pymysql.connect(
            host=u.hostname,
            port=u.port or 3306,
            user=unquote(u.username or ""),
            password=unquote(u.password or ""),
            database=u.path.lstrip("/"),
            # Aiven refuses plaintext. A dict with a "ca" key is what switches TLS
            # on in PyMySQL — with a CA it verifies the certificate, without one
            # it still encrypts.
            ssl={"ca": DB_CA},
            autocommit=True,
            cursorclass=pymysql.cursors.DictCursor,
            # Rows come back in UTC whatever the server's clock is set to.
            init_command="SET time_zone = '+00:00'",
            # rowcount then counts rows that matched, not rows that changed —
            # renaming "night" to "Night" under a case-insensitive collation
            # updates nothing and would otherwise look like a missing preset.
            client_flag=CLIENT.FOUND_ROWS,
            connect_timeout=10,
        )
    except pymysql.Error as e:
        raise HTTPException(503, f"Presets are offline: {e}") from e


def clean_name(name: str) -> str:
    name = name.strip()
    if not name or len(name) > MAX_NAME:
        raise HTTPException(400, f"A preset name is 1–{MAX_NAME} characters")
    return name


@router.get("")
def list_presets(request: Request):
    """Newest first — the one you just saved is the one you look for."""
    me = owner(request)
    with connect() as db, db.cursor() as cur:
        cur.execute(
            "SELECT name, config, created_at FROM user_presets WHERE user_id = %s"
            " ORDER BY created_at DESC",
            (me,),
        )
        rows = cur.fetchall()
    # MySQL hands back a naive datetime; the Z says it is UTC, so the browser
    # doesn't read it as local time and show yesterday.
    for row in rows:
        row["created_at"] = row["created_at"].isoformat() + "Z"
    return rows


@router.put("/{name}")
async def save_preset(name: str, request: Request):
    """Create, or overwrite the preset of the same name."""
    me = owner(request)
    name = clean_name(name)
    config = (await request.json()).get("config")
    if not isinstance(config, str) or len(config) > MAX_CONFIG:
        raise HTTPException(400, "Preset config must be text under 200 KB")

    with connect() as db, db.cursor() as cur:
        # Overwriting keeps the original created_at: the preset is the same
        # preset, and re-saving it should not reshuffle the list.
        cur.execute(
            "INSERT INTO user_presets (user_id, name, config) VALUES (%s, %s, %s)"
            " ON DUPLICATE KEY UPDATE config = VALUES(config)",
            (me, name, config),
        )
    return {"name": name}


@router.patch("/{name}")
async def rename_preset(name: str, request: Request):
    me = owner(request)
    new = clean_name((await request.json()).get("name", ""))
    with connect() as db, db.cursor() as cur:
        try:
            cur.execute(
                "UPDATE user_presets SET name = %s WHERE user_id = %s AND name = %s",
                (new, me, name),
            )
        except pymysql.err.IntegrityError:
            raise HTTPException(409, f"You already have a preset called “{new}”") from None
        if not cur.rowcount:
            raise HTTPException(404, "That preset is gone")
    return {"name": new}


@router.delete("/{name}", status_code=204)
def delete_preset(name: str, request: Request):
    me = owner(request)
    with connect() as db, db.cursor() as cur:
        cur.execute("DELETE FROM user_presets WHERE user_id = %s AND name = %s", (me, name))
