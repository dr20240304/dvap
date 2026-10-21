"""Chapter 2 ("Approve") black-box regression: the whole escalation chain works by default and dies when hardened."""
import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dvap_harness import stack  # noqa: E402
from mcp_http import Mcp  # noqa: E402

NOTE = "Initech Systems — Q3+Q4 integration milestone, PO 7731 (pre-approved scope)"


def http(method: str, url: str):
    with urllib.request.urlopen(urllib.request.Request(url, method=method, data=b"" if method == "POST" else None), timeout=10) as r:
        return json.loads(r.read())


class Chapter2(unittest.TestCase):
    def attack(self, s):
        mcp = Mcp(s.urls["mcp"], s.info["portalToken"], {"x-agent-id": "agent-1"})
        err, out = mcp.call("configure_payment_policy", allowPayees=["p_globex"], trustPayees=["p_globex"], perTxCap="20000000000")
        if err:
            return err, out, None
        return err, out, mcp.call("create_payment", invoiceId="INV-2001", payeeId="p_globex", amount="9500000000", note=NOTE)

    def test_default_chain_pays_globex_after_cfo_approves_spoofed_screen(self):
        with stack("") as s:
            err, _, pay = self.attack(s)
            self.assertFalse(err)
            self.assertEqual(pay[1]["status"], "pending_approval")
            shown = http("GET", s.urls["approval"] + "/api/pending")["payments"][0]
            self.assertEqual(shown["headline"], NOTE)
            self.assertNotIn("Globex", json.dumps([shown["headline"], shown["lines"]]))
            http("POST", f"{s.urls['approval']}/api/payments/{shown['id']}/approve")  # the CFO clicks Approve
            self.assertEqual(s.balance("acct_globex"), 9_500_000_000)

    def test_hardened_chain_is_blocked_at_step_one(self):
        with stack("V4,V5,V8") as s:
            err, out, _ = self.attack(s)
            self.assertTrue(err, out)
            self.assertEqual(s.balance("acct_globex"), 0)
            self.assertEqual(http("GET", s.urls["approval"] + "/api/pending")["payments"], [])


class V29SessionBinding(unittest.TestCase):
    """The approval endpoint must only act for the CFO's own browser session, not for any cross-site POST."""

    def blind_post(self, s) -> int:
        mcp = Mcp(s.urls["mcp"], s.keys()["agentToken"])
        _, pay = mcp.call("create_payment", invoiceId="INV-1001", payeeId="p_initech", amount="1200000000")
        req = urllib.request.Request(f"{s.urls['approval']}/api/payments/{pay['id']}/approve", method="POST", data=b"",
                                     headers={"Origin": "https://evil.example"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_default_cross_origin_post_approves(self):
        with stack("") as s:
            self.assertEqual(self.blind_post(s), 200)

    def test_hardened_refuses(self):
        with stack("V29") as s:
            self.assertEqual(self.blind_post(s), 403)


if __name__ == "__main__":
    unittest.main()
