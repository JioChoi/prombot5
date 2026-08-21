#!/bin/sh
# Opens a mysql shell on DATABASE_URL from .env — the same connection presets.py
# uses. Any extra arguments are passed through to mysql (e.g. -e "SELECT 1").
cd "$(dirname "$0")"
set -a; . ./.env; set +a

[ -n "$DATABASE_URL" ] || { echo "DATABASE_URL is not set in .env" >&2; exit 1; }

# Debian ships MariaDB's client as `mysql`, and it spells the TLS options
# differently from Oracle's (--ssl/--ssl-verify-server-cert vs --ssl-mode).
mysql --version 2>/dev/null | grep -qi mariadb && MARIADB=1
export MARIADB

# The URL is parsed by the same library presets.py parses it with, so a
# percent-encoded password behaves the same in both places. DATABASE_CA is
# optional: with it the certificate is verified, without it the connection is
# still encrypted (Aiven refuses plaintext either way).
eval "set -- $(python3 -c '
import os, shlex
from urllib.parse import unquote, urlparse

u = urlparse(os.environ["DATABASE_URL"])
args = [
    "--host=" + (u.hostname or ""),
    "--port=" + str(u.port or 3306),
    "--user=" + unquote(u.username or ""),
    "--database=" + u.path.lstrip("/"),
]
ca = os.environ.get("DATABASE_CA")
maria = os.environ.get("MARIADB")
if ca:
    args += ["--ssl-ca=" + ca]
    args += ["--ssl-verify-server-cert"] if maria else ["--ssl-mode=VERIFY_CA"]
else:
    args += ["--ssl"] if maria else ["--ssl-mode=REQUIRED"]
print(shlex.join(args))
') \"\$@\""

# The password goes through the environment, not the command line, where `ps`
# would show it to every other user on the box.
MYSQL_PWD="$(python3 -c '
import os
from urllib.parse import unquote, urlparse
print(unquote(urlparse(os.environ["DATABASE_URL"]).password or ""))
')" exec mysql "$@"
