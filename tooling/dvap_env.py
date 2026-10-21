"""Shared defaults for the exploit/demo scripts so they work unchanged on the host (`make dev`) and inside Docker (`make d-*`).

URLs come from env vars (set in the `tools` container): MCP_URL, MERCHANT_URL, LEDGER_URL, ROGUE_URL, VENDOR_MCP_URL.
Secrets come from <DVAP_DATA_DIR>/keys.json, the same file the services use. Only the *demo operator* reads it, to play
the roles the demos assign (the supplier holding a portal token, the operator checking the ledger).
"""
import json
import os
import urllib.request
from pathlib import Path

DATA = Path(os.environ.get("DVAP_DATA_DIR", Path(__file__).resolve().parent.parent / ".dvap-data"))
MCP_URL = os.environ.get("MCP_URL", "http://127.0.0.1:4100/mcp")
MERCHANT_URL = os.environ.get("MERCHANT_URL", "http://127.0.0.1:4021")
LEDGER_URL = os.environ.get("LEDGER_URL", "http://127.0.0.1:4000")


def keys() -> dict:
    return json.loads((DATA / "keys.json").read_text())


def ledger_get(path: str):
    req = urllib.request.Request(LEDGER_URL + path, headers={"x-service-key": keys()["serviceKey"]})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def resolve(value: str | None, auto):
    """'auto' (or nothing) -> compute it; anything else is used verbatim."""
    return auto() if value in (None, "", "auto") else value
