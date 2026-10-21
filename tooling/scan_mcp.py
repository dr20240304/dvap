#!/usr/bin/env python3
"""scan_mcp — a small heuristic scanner for MCP servers (stdlib only).

Lists a server's tools and flags what a reviewer should look at. These are heuristics, not proof: a clean scan means
"nothing obvious", and every finding needs a human to confirm. Mapping to the OWASP MCP Top 10 (2025 beta) is our judgement.

  scan_mcp.py <url> [--token T] [--header 'X-Name: v'] [--save-baseline FILE | --baseline FILE]

--save-baseline records a hash of every tool (name+description+schema); --baseline later reports tools that CHANGED or APPEARED
(rug-pull / tool-poisoning-after-approval detection, MCP03 / MCP04). Exit code 1 if any HIGH finding.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dvap_env import keys  # noqa: E402
from mcp_http import Mcp  # noqa: E402

INJECTION = [
    (r"ASSISTANT_INSTRUCTION|ignore (all |any )?(previous|prior) instructions|disregard (the )?(above|previous)", "explicit instruction aimed at the model"),
    (r"do not (mention|tell|reveal|inform)|don't (mention|tell)|without (telling|informing|notifying) the user|secret(ly)?", "asks the model to hide something from the user"),
    (r"<\s*important\s*>|\bIMPORTANT\s*[—:-]", "'IMPORTANT' block inside a tool description"),
    (r"\b(before|after) (using|calling|running) this tool,? (you must |first )?(call|run|invoke)\b", "tool description orders other tool calls"),
]
POWERFUL = re.compile(r"(configure|policy|mandate|permission|grant|admin|exec|shell|eval|sudo|delete|transfer|approve)", re.I)
INJECTABLE_PARAM = re.compile(r"^(title|name|command|cmd|path|file|filename|url|query|script|template|note|message)$", re.I)


def finding(sev, owasp, tool, msg):
    return {"severity": sev, "owasp_mcp": owasp, "tool": tool, "message": msg}


def tool_hash(t: dict) -> str:
    return hashlib.sha256(json.dumps({"n": t["name"], "d": t.get("description", ""), "s": t.get("inputSchema")}, sort_keys=True).encode()).hexdigest()


def scan(tools: list[dict], baseline: dict | None = None) -> list[dict]:
    out = []
    for t in tools:
        name, desc = t["name"], t.get("description", "") or ""
        for pat, why in INJECTION:
            if re.search(pat, desc, re.I):
                out.append(finding("HIGH", "MCP03 Tool Poisoning", name, f"description {why}"))
        if len(desc) > 600:
            out.append(finding("LOW", "MCP03 Tool Poisoning", name, f"unusually long description ({len(desc)} chars) — read it all"))
        if POWERFUL.search(name):
            out.append(finding("MEDIUM", "MCP02 Privilege Escalation via Scope Creep", name, "tool can change permissions/policy or move value; confirm it is scoped to callers that need it"))
        for pname, spec in (t.get("inputSchema", {}).get("properties", {}) or {}).items():
            if spec.get("type") == "string" and INJECTABLE_PARAM.match(pname) and "pattern" not in spec and "enum" not in spec:
                out.append(finding("MEDIUM", "MCP05 Command Injection", name, f"free-form string parameter '{pname}' with no pattern/enum — check how the server uses it"))
        if baseline is not None:
            if name not in baseline:
                out.append(finding("MEDIUM", "MCP04 Supply Chain / Shadow tools", name, "tool is new since the baseline"))
            elif baseline[name] != tool_hash(t):
                out.append(finding("HIGH", "MCP03 Tool Poisoning", name, "tool definition CHANGED since the baseline (possible rug pull)"))
    if baseline is not None:
        for gone in set(baseline) - {t["name"] for t in tools}:
            out.append(finding("LOW", "MCP04 Supply Chain / Shadow tools", gone, "tool disappeared since the baseline"))
    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    return sorted(out, key=lambda f: order[f["severity"]])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", nargs="?", default=os.environ.get("MCP_URL", "http://127.0.0.1:4100/mcp"))
    ap.add_argument("--token", default="")
    ap.add_argument("--header", action="append", default=[])
    ap.add_argument("--save-baseline")
    ap.add_argument("--baseline")
    a = ap.parse_args()
    if a.token == "auto":
        a.token = keys()["portalToken"]  # the credential a supplier would hold
    headers = dict(h.split(":", 1) for h in a.header)
    headers = {k.strip(): v.strip() for k, v in headers.items()}
    mcp = Mcp(a.url, a.token, headers)
    if not a.token:
        mcp.headers.pop("authorization", None)
    tools = mcp.rpc("tools/list")["result"]["tools"]
    print(f"{a.url}: {len(tools)} tools -> {', '.join(t['name'] for t in tools)}")
    if a.save_baseline:
        Path(a.save_baseline).write_text(json.dumps({t["name"]: tool_hash(t) for t in tools}, indent=2))
        print(f"baseline saved to {a.save_baseline}")
    baseline = json.loads(Path(a.baseline).read_text()) if a.baseline else None
    findings = scan(tools, baseline)
    for f in findings:
        print(f"[{f['severity']:<6}] {f['tool']:<26} {f['owasp_mcp']}: {f['message']}")
    print(f"\n{len(findings)} finding(s). Heuristic scan — confirm each by hand.")
    return 1 if any(f["severity"] == "HIGH" for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
