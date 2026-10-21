"""Spawn a throwaway DVAP stack (plus the attacker's rogue merchant) for security tests and exploit demos.

stdlib only. The stack is the real TypeScript system (`scripts/serve.ts`) on ephemeral ports in a temp dir, so every
run starts from the same seeded Acme world. `harden` is passed straight through as DVAP_HARDEN.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Stack:
    def __init__(self, info: dict, harden: str):
        self.info, self.harden = info, harden
        self.urls = info["urls"]
        self.data_dir = info["dir"]

    def keys(self) -> dict:
        return json.loads((Path(self.data_dir) / "keys.json").read_text())

    def ledger_get(self, path: str):
        req = urllib.request.Request(self.urls["ledger"] + path, headers={"x-service-key": self.info["serviceKey"]})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def balance(self, account: str) -> int:
        return int(self.ledger_get(f"/accounts/{account}")["balance"])

    def env(self, **extra) -> dict:
        e = {**os.environ, "DVAP_HARDEN": self.harden, "DVAP_DATA_DIR": self.data_dir, "DVAP_QUIET": "1",
             "NODE_OPTIONS": "--disable-warning=ExperimentalWarning",
             "MCP_URL": self.urls["mcp"], "MERCHANT_URL": self.urls["merchant"]}
        e.pop("VENDOR_MCP_URL", None)  # the Docker tools container points this at a live server; tests must opt in explicitly
        e.update(extra)
        return e

    def pay(self, *args: str, **env) -> dict:
        """Run scripts/pay.ts (the x402 buyer CLI) with the agent's key and return its JSON output."""
        r = subprocess.run(["npx", "tsx", "scripts/pay.ts", *args], cwd=ROOT, env=self.env(**env), capture_output=True, text=True, timeout=120)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def run_agent(self, prompt: str, **env) -> subprocess.CompletedProcess:
        """Run the scripted agent CLI against this stack (e.g. MERCHANT_URL=<rogue> to simulate a hijacked vendor API)."""
        return subprocess.run(
            ["npx", "tsx", "src/agent/index.ts", prompt], cwd=ROOT, env=self.env(**env),
            capture_output=True, text=True, timeout=60,
        )


@contextmanager
def stack(harden: str = ""):
    """Yield a running Stack. DVAP_HARDEN is applied to the services at launch AND to anything started via Stack.env()."""
    env = {**os.environ, "DVAP_HARDEN": harden, "NODE_OPTIONS": "--disable-warning=ExperimentalWarning"}
    proc = subprocess.Popen(["npx", "tsx", "scripts/serve.ts"], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline()  # type: ignore[union-attr]
        if not line:
            raise RuntimeError("serve.ts exited before printing its descriptor")
        yield Stack(json.loads(line), harden)
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        proc.stdout.close()  # type: ignore[union-attr]
