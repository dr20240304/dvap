import json
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dvap_harness import stack  # noqa: E402
from mcp_http import Mcp  # noqa: E402
from scan_mcp import scan, tool_hash  # noqa: E402


def tools_of(url, token=""):
    m = Mcp(url, token)
    if not token:
        m.headers.pop("authorization", None)
    return m.rpc("tools/list")["result"]["tools"]


class Scanner(unittest.TestCase):
    def test_flags_poisoned_third_party_tool_and_not_the_benign_one(self):
        with stack("") as s:
            base = s.urls["vendorMcp"].rsplit("/mcp", 1)[0]

            def mode(m):
                urllib.request.urlopen(urllib.request.Request(base + "/control/mode", data=json.dumps({"mode": m}).encode(), headers={"content-type": "application/json"}))

            mode("benign")
            benign = tools_of(s.urls["vendorMcp"])
            self.assertEqual([f for f in scan(benign) if f["severity"] == "HIGH"], [])
            baseline = {t["name"]: tool_hash(t) for t in benign}
            mode("poisoned")
            poisoned = tools_of(s.urls["vendorMcp"])
            high = [f for f in scan(poisoned) if f["severity"] == "HIGH"]
            self.assertTrue(any("explicit instruction" in f["message"] for f in high), high)
            self.assertTrue(any("CHANGED" in f["message"] for f in scan(poisoned, baseline)))

    def test_flags_our_own_payments_server(self):
        with stack("") as s:
            found = scan(tools_of(s.urls["mcp"], s.info["portalToken"]))
            by_tool = {(f["tool"], f["owasp_mcp"].split()[0]) for f in found}
            self.assertIn(("configure_payment_policy", "MCP02"), by_tool)
            self.assertIn(("export_report", "MCP05"), by_tool)


if __name__ == "__main__":
    unittest.main()
