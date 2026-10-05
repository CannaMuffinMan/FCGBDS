import json


def asgi_middleware(client):
    """ASGI middleware. Allow calls the inner app. Challenge and block return JSON."""

    def wrap(app):
        async def handle(scope, receive, send):
            if scope.get("type") != "http":
                await app(scope, receive, send)
                return
            headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
            ip = headers.get("x-forwarded-for", "unknown").split(",")[0].strip()
            path = scope.get("path") or "/"
            decision = client.evaluate(scope.get("method") or "GET", path, ip, headers)
            response = decision.get("response")
            if not response or decision.get("result", {}).get("action") == "allow":
                await app(scope, receive, send)
                return
            body = json.dumps(response).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": int(response.get("httpStatus") or 403),
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"x-fcgbds-decision", str(response.get("decision", "")).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})

        return handle

    return wrap
