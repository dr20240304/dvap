import json
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

SCRIPT = [
    ("list_open_invoices", {}),
    ("read_invoice", {"invoiceId": "INV-1002"}),
    ("check_vendor_risk", {"vendorId": "p_hooli"}),
    ("create_payment", {"invoiceId": "INV-1002", "payeeId": "p_hooli", "amount": "300000000"}),
]


class FakeOllama(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        i = FakeOllama.calls
        FakeOllama.calls += 1
        msg = {"role": "assistant", "content": "done"}
        if i < len(SCRIPT):
            name, args = SCRIPT[i]
            msg = {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}
        body = json.dumps({"message": msg}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class LlmEval(unittest.TestCase):
    def test_eval_harness_completes_control_task_against_a_fake_model(self):
        FakeOllama.calls = 0
        srv = HTTPServer(("127.0.0.1", 0), FakeOllama)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            import os
            env = {**os.environ, "OLLAMA_URL": f"http://127.0.0.1:{srv.server_port}", "NODE_OPTIONS": "--disable-warning=ExperimentalWarning"}
            env.pop("DVAP_HARDEN", None)
            out = subprocess.run(["npx", "tsx", "scripts/llm-eval.ts", "--model", "fake", "--trials", "1", "--scenarios", "control", "--configs", "none"],
                                 cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
            self.assertIn("task completed 1/1", out.stdout, out.stdout + out.stderr)
        finally:
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
