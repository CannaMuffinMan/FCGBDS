package fcgbds

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

type EvaluateRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	IP      string            `json:"ip"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    any               `json:"body,omitempty"`
}

type DecisionBody struct {
	Error      string   `json:"error"`
	Message    string   `json:"message"`
	HTTPStatus int      `json:"httpStatus"`
	Decision   string   `json:"decision"`
	Score      int      `json:"score"`
	Signals    []string `json:"signals"`
}

type EvaluateResponse struct {
	Result struct {
		Action            string `json:"action"`
		Score             int    `json:"score"`
		Mode              string `json:"mode"`
		Enforced          bool   `json:"enforced"`
		WouldHaveBlocked  bool   `json:"wouldHaveBlocked"`
		ProfileID         string `json:"profileId"`
	} `json:"result"`
	Response *DecisionBody `json:"response"`
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) Evaluate(req EvaluateRequest) (EvaluateResponse, error) {
	var out EvaluateResponse
	payload, err := json.Marshal(req)
	if err != nil {
		return out, err
	}
	httpReq, err := http.NewRequest(http.MethodPost, strings.TrimRight(c.BaseURL, "/")+"/v1/evaluate", bytes.NewReader(payload))
	if err != nil {
		return out, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := c.httpClient().Do(httpReq)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return out, err
	}
	if res.StatusCode >= 300 {
		return out, fmt.Errorf("fcgbds evaluate status %d: %s", res.StatusCode, string(body))
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, err
	}
	return out, nil
}
