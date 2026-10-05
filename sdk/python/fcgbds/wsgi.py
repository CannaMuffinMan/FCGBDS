import json


def wsgi_middleware(client, app):
    def handle(environ, start_response):
        path = environ.get("PATH_INFO") or "/"
        method = environ.get("REQUEST_METHOD") or "GET"
        ip = environ.get("HTTP_X_FORWARDED_FOR", environ.get("REMOTE_ADDR", "unknown")).split(",")[0].strip()
        headers = {}
        for key, value in environ.items():
            if key.startswith("HTTP_"):
                headers[key[5:].replace("_", "-").lower()] = value
        decision = client.evaluate(method, path, ip, headers)
        response = decision.get("response")
        if not response or decision.get("result", {}).get("action") == "allow":
            return app(environ, start_response)
        body = json.dumps(response).encode()
        status = int(response.get("httpStatus") or 403)
        start_response(
            f"{status} {'Blocked' if status == 403 else 'Challenge'}",
            [("Content-Type", "application/json"), ("X-FCGBDS-Decision", str(response.get("decision", "")))],
        )
        return [body]

    return handle
