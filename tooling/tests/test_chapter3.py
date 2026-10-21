"""Regression tests for Chapter 3 ("Pay"): each bug is exploitable by default and blocked by its DVAP_HARDEN flag.

Black-box: these boot the real TypeScript stack and attack it over HTTP / the agent CLI.
Run:  python3 -m unittest discover -s tooling/tests -v      (from dvap/)
"""
import http.client
import sys
import unittest
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dvap_harness import stack  # noqa: E402

AGENT_WALLET, ATTACKER, VETTINGCO = "acct_agent_wallet", "acct_globex_drop", "acct_vettingco"
BYPASS_PATHS = ["//v1/premium/vendor-deep-dive/p_globex", "/V1/Premium/vendor-deep-dive/p_globex", "/v1//premium//vendor-deep-dive/p_globex"]
NORMAL = "/v1/premium/vendor-deep-dive/p_globex"


def raw_get(base: str, path: str) -> tuple[int, str]:
    u = urlparse(base)
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    c.request("GET", path)
    r = c.getresponse()
    return r.status, r.read().decode()


class V15GateBypass(unittest.TestCase):
    def test_default_is_exploitable(self):
        with stack("") as s:
            self.assertEqual(raw_get(s.urls["merchant"], NORMAL)[0], 402, "control: normal path must be paywalled")
            for p in BYPASS_PATHS:
                status, body = raw_get(s.urls["merchant"], p)
                self.assertEqual(status, 200, p)
                self.assertIn("Shell-company", body)
            self.assertEqual(s.balance(VETTINGCO), 0, "attacker read paid data without anyone paying")

    def test_hardened_blocks_it(self):
        with stack("V15") as s:
            for p in [NORMAL, *BYPASS_PATHS]:
                self.assertEqual(raw_get(s.urls["merchant"], p)[0], 402, p)


class V7RoguePayee(unittest.TestCase):
    PROMPT = "Pay the Globex invoice INV-2001"

    def test_default_agent_pays_attacker(self):
        with stack("") as s:
            before = s.balance(AGENT_WALLET)
            out = s.run_agent(self.PROMPT, MERCHANT_URL=s.urls["rogue"])
            self.assertEqual(s.balance(ATTACKER), 15_000_000, out.stdout + out.stderr)
            self.assertEqual(s.balance(AGENT_WALLET), before - 15_000_000)
            self.assertIn("vendor risk 4/100", out.stdout)  # forged clean report fooled the agent

    def test_hardened_agent_refuses(self):
        with stack("V7") as s:
            before = s.balance(AGENT_WALLET)
            out = s.run_agent(self.PROMPT, MERCHANT_URL=s.urls["rogue"])
            self.assertEqual(s.balance(ATTACKER), 0, out.stdout + out.stderr)
            self.assertEqual(s.balance(AGENT_WALLET), before)
            self.assertIn("challenge_rejected", out.stdout)


if __name__ == "__main__":
    unittest.main()
