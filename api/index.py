"""Vercel entry point: the whole FastAPI app as one Python function.

Vercel's Python runtime looks for a module-level ASGI `app` in a file under
api/, so this is a two-line shim around backend/main.py. STATIC_DIR stays unset
here — on Vercel the built site is served by the CDN, not by uvicorn, and the
catch-all route in main.py would otherwise swallow every static path.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from main import app  # noqa: E402

__all__ = ["app"]
