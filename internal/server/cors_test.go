package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/ratelimit"
)

const space = "https://space.cloistr.xyz"

func corsTestHandler(t *testing.T, rl *ratelimit.Limiter) http.Handler {
	t.Helper()
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"files":[]}`)) })
	mux := http.NewServeMux()
	mux.Handle("GET /api/files", ok)
	mux.Handle("DELETE /api/files/{sha256}", ok)
	mux.Handle("/", ok) // the static catch-all, which answers any method
	s := &Server{mux: mux, rateLimiter: rl, corsOrigins: corsOriginSet([]string{space + "/", " https://docs.cloistr.xyz"})}
	return s.Handler()
}

func preflight(h http.Handler, origin, method, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodOptions, path, nil)
	r.Header.Set("Origin", origin)
	r.Header.Set("Access-Control-Request-Method", method)
	r.Header.Set("Access-Control-Request-Headers", "x-blossom-auth")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestCORS_ListedOriginPreflight(t *testing.T) {
	h := corsTestHandler(t, nil)
	for _, m := range []string{"GET", "DELETE", "POST"} {
		w := preflight(h, space, m, "/api/files/abc")
		if w.Code != http.StatusNoContent {
			t.Fatalf("%s preflight = %d, want 204", m, w.Code)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != space {
			t.Fatalf("Allow-Origin = %q, want %q", got, space)
		}
		if !strings.Contains(w.Header().Get("Access-Control-Allow-Methods"), m) {
			t.Fatalf("Allow-Methods %q lacks %s", w.Header().Get("Access-Control-Allow-Methods"), m)
		}
		for _, hdr := range []string{"Authorization", "X-Blossom-Auth"} {
			if !strings.Contains(w.Header().Get("Access-Control-Allow-Headers"), hdr) {
				t.Fatalf("Allow-Headers %q lacks %s", w.Header().Get("Access-Control-Allow-Headers"), hdr)
			}
		}
		if w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatal("Allow-Credentials must not be sent")
		}
	}
}

func TestCORS_ListedOriginGet(t *testing.T) {
	h := corsTestHandler(t, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/files?pubkey=x", nil)
	r.Header.Set("Origin", space)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Body.String() != `{"files":[]}` {
		t.Fatalf("GET = %d %q", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != space {
		t.Fatalf("Allow-Origin = %q, want %q", got, space)
	}
	if !strings.Contains(strings.Join(w.Header().Values("Vary"), ","), "Origin") {
		t.Fatal("Vary: Origin missing")
	}
}

func TestCORS_UnlistedOriginGetsNoHeaders(t *testing.T) {
	h := corsTestHandler(t, nil)
	check := func(name string, w *httptest.ResponseRecorder) {
		t.Helper()
		for k := range w.Header() {
			if strings.HasPrefix(k, "Access-Control-") {
				t.Fatalf("%s: unlisted origin got %s: %q", name, k, w.Header().Get(k))
			}
		}
	}
	for _, o := range []string{"https://evil.example", "https://space.cloistr.xyz.evil.example", "http://space.cloistr.xyz", "null"} {
		check("preflight "+o, preflight(h, o, "DELETE", "/api/files/abc"))
		r := httptest.NewRequest(http.MethodGet, "/api/files", nil)
		r.Header.Set("Origin", o)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		check("GET "+o, w)
	}
}

func TestCORS_NoOriginUnchanged(t *testing.T) {
	h := corsTestHandler(t, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/files", nil))
	if w.Code != http.StatusOK || len(w.Header().Values("Vary")) != 0 {
		t.Fatalf("same-origin GET = %d, Vary %v", w.Code, w.Header().Values("Vary"))
	}
}

// A 429 from the limiter still names the origin, so Space sees the real
// status instead of an opaque CORS failure; preflights spend no token.
func TestCORS_RateLimitedResponseKeepsHeaders(t *testing.T) {
	rl := ratelimit.NewLimiter(ratelimit.Config{RequestsPerMinute: 1, BurstSize: 1, UploadsPerMinute: 1, CleanupInterval: time.Hour})
	t.Cleanup(rl.Stop)
	h := corsTestHandler(t, rl)
	get := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/files", nil)
		r.Header.Set("Origin", space)
		r.Header.Set("X-Real-IP", "203.0.113.9")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest(http.MethodOptions, "/api/files", nil)
		r.Header.Set("Origin", space)
		r.Header.Set("Access-Control-Request-Method", "GET")
		r.Header.Set("X-Real-IP", "203.0.113.9")
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	if w := get(); w.Code != http.StatusOK {
		t.Fatalf("first GET after preflights = %d, want 200 (preflight spent a token)", w.Code)
	}
	w := get()
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("second GET = %d, want 429", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != space {
		t.Fatal("429 lacks Allow-Origin")
	}
}

func TestCORS_NoOriginsConfiguredSendsNothing(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {})
	h := (&Server{mux: mux, corsOrigins: corsOriginSet(nil)}).Handler()
	w := preflight(h, space, "GET", "/api/files")
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("no configured origins must mean no CORS headers")
	}
}
