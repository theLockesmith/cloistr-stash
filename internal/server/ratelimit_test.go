package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/ratelimit"
)

// With the limiter on, health and metrics stay reachable from a client whose
// bucket is empty, while ordinary routes are limited.
func TestHandler_ProbesBypassRateLimit(t *testing.T) {
	rl := ratelimit.NewLimiter(ratelimit.Config{
		RequestsPerMinute: 1,
		BurstSize:         1,
		UploadsPerMinute:  1,
		CleanupInterval:   time.Hour,
	})
	t.Cleanup(rl.Stop)

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	mux := http.NewServeMux()
	mux.Handle("GET /health", ok)
	mux.Handle("GET /metrics", ok)
	mux.Handle("GET /api/files", ok)
	s := &Server{mux: mux, rateLimiter: rl}
	h := s.Handler()

	get := func(path string) int {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("X-Real-IP", "10.128.4.2") // a node's address, as kubelet sees it
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}

	if c := get("/api/files"); c != http.StatusOK {
		t.Fatalf("first /api/files = %d, want 200", c)
	}
	if c := get("/api/files"); c != http.StatusTooManyRequests {
		t.Fatalf("second /api/files = %d, want 429 (bucket drained)", c)
	}
	for i := 0; i < 5; i++ {
		for _, p := range []string{"/health", "/metrics"} {
			if c := get(p); c != http.StatusOK {
				t.Fatalf("%s with drained bucket = %d, want 200", p, c)
			}
		}
	}
}
