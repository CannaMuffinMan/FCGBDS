package fcgbds

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMiddlewareBlocksWithBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{"action": "block", "score": 90, "mode": "enforce"},
			"response": map[string]any{
				"error": "request_blocked", "message": "This request was blocked by the site operator’s bot defense.",
				"httpStatus": 403, "decision": "block", "score": 90, "signals": []string{"automation"},
			},
		})
	}))
	defer upstream.Close()

	handler := Middleware(&Client{BaseURL: upstream.URL}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "http://app.example/login", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d", rec.Code)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("empty body")
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "request_blocked" {
		t.Fatalf("body %#v", body)
	}
}

func TestMiddlewareAllows(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result":   map[string]any{"action": "allow", "score": 0, "mode": "observe"},
			"response": nil,
		})
	}))
	defer upstream.Close()
	called := false
	handler := Middleware(&Client{BaseURL: upstream.URL}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "http://app.example/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if !called || rec.Code != http.StatusNoContent {
		t.Fatalf("called %v code %d", called, rec.Code)
	}
}
