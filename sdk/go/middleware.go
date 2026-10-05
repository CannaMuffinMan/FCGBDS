package fcgbds

import (
	"encoding/json"
	"net"
	"net/http"
)

// Middleware evaluates the request against the operator's FCGBDS instance.
// Allowed requests call next. Challenge and block responses include a JSON body.
func Middleware(client *Client, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr
		}
		headers := map[string]string{}
		for key, values := range r.Header {
			if len(values) > 0 {
				headers[key] = values[0]
			}
		}
		decision, err := client.Evaluate(EvaluateRequest{
			Method:  r.Method,
			Path:    r.URL.Path,
			IP:      ip,
			Headers: headers,
		})
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error":   "defense_unavailable",
				"message": "The FCGBDS instance could not be reached.",
			})
			return
		}
		if decision.Response == nil || decision.Result.Action == "allow" {
			next.ServeHTTP(w, r)
			return
		}
		status := decision.Response.HTTPStatus
		if status == 0 {
			status = http.StatusForbidden
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-FCGBDS-Decision", decision.Response.Decision)
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(decision.Response)
	})
}
