import json
import unittest
from unittest.mock import patch

from fcgbds.asgi import asgi_middleware
from fcgbds.client import FcgbdsClient
from fcgbds.wsgi import wsgi_middleware


class FakeClient(FcgbdsClient):
    def __init__(self, payload):
        super().__init__("http://fcgbds.invalid")
        self.payload = payload

    def evaluate(self, method, path, ip, headers=None, body=None):
        return self.payload


class MiddlewareTests(unittest.TestCase):
    def test_wsgi_block_has_body(self):
        client = FakeClient(
            {
                "result": {"action": "block"},
                "response": {
                    "error": "request_blocked",
                    "message": "This request was blocked by the site operator’s bot defense.",
                    "httpStatus": 403,
                    "decision": "block",
                    "score": 90,
                    "signals": ["automation"],
                },
            }
        )

        def app(environ, start_response):
            start_response("200 OK", [("Content-Type", "text/plain")])
            return [b"ok"]

        wrapped = wsgi_middleware(client, app)
        status = {}

        def start_response(code, headers):
            status["code"] = code
            status["headers"] = headers

        body = b"".join(wrapped({"PATH_INFO": "/login", "REQUEST_METHOD": "POST", "REMOTE_ADDR": "203.0.113.9"}, start_response))
        self.assertTrue(status["code"].startswith("403"))
        parsed = json.loads(body)
        self.assertEqual(parsed["error"], "request_blocked")
        self.assertGreater(len(body), 0)

    def test_asgi_allow(self):
        client = FakeClient({"result": {"action": "allow"}, "response": None})
        called = {}

        async def app(scope, receive, send):
            called["yes"] = True
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        import asyncio

        async def run():
            messages = []

            async def send(message):
                messages.append(message)

            await asgi_middleware(client)(app)({"type": "http", "path": "/", "method": "GET", "headers": []}, None, send)
            self.assertTrue(called.get("yes"))
            self.assertEqual(messages[0]["status"], 204)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
