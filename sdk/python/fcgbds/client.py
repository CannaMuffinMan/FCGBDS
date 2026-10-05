import json
import urllib.error
import urllib.request


class FcgbdsClient:
    def __init__(self, base_url: str, api_token: str = ""):
        self.base_url = base_url.rstrip("/")
        self.api_token = api_token

    def _request(self, method: str, path: str, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {"content-type": "application/json"} if data is not None else {}
        if self.api_token:
            headers["authorization"] = f"Bearer {self.api_token}"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()
            raise RuntimeError(f"FCGBDS {method} {path} failed ({exc.code}): {detail}") from exc

    def evaluate(self, method: str, path: str, ip: str, headers=None, body=None):
        return self._request(
            "POST",
            "/v1/evaluate",
            {"method": method, "path": path, "ip": ip, "headers": headers or {}, "body": body},
        )

    def health(self):
        return self._request("GET", "/health")
