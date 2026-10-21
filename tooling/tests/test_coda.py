import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dvap_harness import stack  # noqa: E402
from mcp_http import Mcp  # noqa: E402

TOOLING = Path(__file__).resolve().parents[1]


class Coda(unittest.TestCase):
    def pending_payment(self, s):
        import json, urllib.request  # noqa: E401
        req = urllib.request.Request(s.urls["ledger"] + "/agents/agent-1/policy", method="PUT",
                                     data=json.dumps({"actor": "setup", "allowPayees": ["p_globex"], "trustPayees": ["p_globex"], "perTxCap": "20000000000"}).encode(),
                                     headers={"content-type": "application/json", "x-service-key": s.info["serviceKey"]})
        urllib.request.urlopen(req, timeout=5).read()
        err, pay = Mcp(s.urls["mcp"], s.info["portalToken"], {"x-agent-id": "agent-1"}).call(
            "create_payment", invoiceId="INV-2001", payeeId="p_globex", amount="9500000000")
        self.assertFalse(err, pay)
        return pay["id"]

    def run_exploit(self, s, pid):
        return subprocess.run([sys.executable, str(TOOLING / "exploits/coda_pwn.py"), s.urls["mcp"], s.urls["ledger"], s.info["portalToken"], s.data_dir, pid],
                              capture_output=True, text=True, timeout=30)

    def test_default_leaks_secrets_and_self_approves(self):
        with stack("") as s:
            out = self.run_exploit(s, self.pending_payment(s))
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
            self.assertEqual(s.balance("acct_globex"), 9_500_000_000)

    def test_hardened_v10_blocks_the_leak(self):
        with stack("V10") as s:
            out = self.run_exploit(s, self.pending_payment(s))
            self.assertEqual(out.returncode, 1, out.stdout)
            self.assertEqual(s.balance("acct_globex"), 0)


if __name__ == "__main__":
    unittest.main()
