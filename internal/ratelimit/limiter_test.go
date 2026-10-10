package ratelimit

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestLimiter(t *testing.T, burst int) *Limiter {
	t.Helper()
	l := NewLimiter(Config{
		RequestsPerMinute: 1,
		BurstSize:         burst,
		UploadsPerMinute:  1,
		CleanupInterval:   time.Hour,
	})
	t.Cleanup(l.Stop)
	return l
}

func TestGetClientKey(t *testing.T) {
	l := newTestLimiter(t, 1)

	tests := []struct {
		name       string
		remoteAddr string
		xRealIP    string
		xff        string
		want       string
	}{
		{"X-Real-IP wins over forged XFF", "10.0.0.5:4000", "203.0.113.7", "1.2.3.4", "203.0.113.7"},
		{"XFF alone is ignored", "10.0.0.5:4000", "", "1.2.3.4, 203.0.113.7", "10.0.0.5"},
		{"port stripped from RemoteAddr", "10.0.0.5:51234", "", "", "10.0.0.5"},
		{"non-IP X-Real-IP falls back to peer", "10.0.0.5:4000", "not-an-ip", "", "10.0.0.5"},
		{"X-Real-IP whitespace trimmed", "10.0.0.5:4000", " 203.0.113.7 ", "", "203.0.113.7"},
		{"IPv6 X-Real-IP normalised", "10.0.0.5:4000", "2001:DB8::1", "", "2001:db8::1"},
		{"IPv6 peer", "[2001:db8::2]:4000", "", "", "2001:db8::2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tt.remoteAddr
			if tt.xRealIP != "" {
				r.Header.Set("X-Real-IP", tt.xRealIP)
			}
			if tt.xff != "" {
				r.Header.Set("X-Forwarded-For", tt.xff)
			}
			if got := l.getClientKey(r); got != tt.want {
				t.Errorf("getClientKey() = %q, want %q", got, tt.want)
			}
		})
	}
}

// A client behind the edge cannot escape its limit by sending a fresh
// X-Forwarded-For on every request: the edge sets X-Real-IP to the same real
// address each time, and that is what the bucket is keyed on.
func TestMiddleware_ForgedXFFDoesNotBypassLimit(t *testing.T) {
	const burst = 3
	l := newTestLimiter(t, burst)
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	limited := 0
	for i := 0; i < burst+5; i++ {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = "10.128.0.9:8443" // the cluster router
		r.Header.Set("X-Real-IP", "198.51.100.23")
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("6.6.6.%d, 198.51.100.23", i))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited != 5 {
		t.Fatalf("got %d rate-limited responses, want 5 (forged XFF must not create new buckets)", limited)
	}
}

// Without X-Real-IP, connections from one peer on different source ports share
// a bucket.
func TestMiddleware_PeerPortDoesNotBypassLimit(t *testing.T) {
	l := newTestLimiter(t, 1)
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	codes := make([]int, 2)
	for i := range codes {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = fmt.Sprintf("10.0.0.5:%d", 40000+i)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		codes[i] = w.Code
	}
	if codes[1] != http.StatusTooManyRequests {
		t.Fatalf("second request from same peer got %d, want 429", codes[1])
	}
}

func TestMiddleware_RateLimitHeader(t *testing.T) {
	l := newTestLimiter(t, 1)
	l.config.RequestsPerMinute = 60
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	var w *httptest.ResponseRecorder
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("X-Real-IP", "198.51.100.23")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
	}
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", w.Code)
	}
	if got := w.Header().Get("X-RateLimit-Limit"); got != "60" {
		t.Errorf("X-RateLimit-Limit = %q, want %q", got, "60")
	}
}
