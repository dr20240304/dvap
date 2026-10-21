"""Minimal stdlib MCP-over-HTTP client (Streamable HTTP, stateless server): enough to call tools as an attacker would."""
import json
import urllib.request
import urllib.error


class McpError(Exception):
    pass


def _parse(body: str) -> dict:
    body = body.strip()
    if body.startswith("{"):
        return json.loads(body)
    for line in body.splitlines():  # SSE framing: "event: message\ndata: {...}"
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise McpError(f"unparseable MCP response: {body[:200]}")


class Mcp:
    def __init__(self, url: str, token: str, headers: dict | None = None):
        self.url, self.headers, self._id = url, {"authorization": f"Bearer {token}", **(headers or {})}, 0

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        data = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}).encode()
        h = {"content-type": "application/json", "accept": "application/json, text/event-stream", **self.headers}
        try:
            with urllib.request.urlopen(urllib.request.Request(self.url, data=data, headers=h), timeout=15) as r:
                return _parse(r.read().decode())
        except urllib.error.HTTPError as e:
            raise McpError(f"HTTP {e.code}: {e.read().decode()[:200]}") from None

    def tools(self) -> list[str]:
        return [t["name"] for t in self.rpc("tools/list")["result"]["tools"]]

    def call(self, name: str, **args) -> tuple[bool, object]:
        """Returns (is_error, parsed JSON or raw text)."""
        res = self.rpc("tools/call", {"name": name, "arguments": args})["result"]
        text = res["content"][0]["text"]
        if res.get("isError"):
            return True, text
        try:
            return False, json.loads(text)
        except ValueError:
            return False, text
