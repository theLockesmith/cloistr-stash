package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/metrics"
)

// 2026-10-15: a pod that started during a relay outage kept a nil metadata
// store for 3 hours, answered half of all list requests with an EMPTY list
// ("you have no files") and panicked on /api/keyring. Every data route must
// say 503 instead. Readiness does NOT gate on the relay (cloistr-pr on !192):
// pulling every pod in an outage would take down the UI and downloads too.

var dataRoutes = []string{
	"/api/files?",
	"/api/files?folder=&",
	"/api/folders?",
	"/api/folders/some-folder?",
	"/api/shares?",
	"/api/keyring?",
}

// ownGet makes a signed GET for sk's own data, bounded to 500ms so a relay
// that never answers fails fast (the handlers' own timeout is 10s).
func ownGet(t *testing.T, s *Server, sk, path string) *httptest.ResponseRecorder {
	t.Helper()
	target := path + "pubkey=" + pub(sk)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, target, nil).WithContext(ctx)
	r.Header.Set("Authorization", nip98Header(t, sk, "http://example.com"+target, "GET"))
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, r)
	return w
}

func TestDataRoutesSay503WithoutAStore(t *testing.T) {
	s := setupTestServer(t) // metadata nil, as on the failed pod
	sk := nostr.GeneratePrivateKey()
	for _, p := range dataRoutes {
		if w := ownGet(t, s, sk, p); w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s with no store = %d (%s), want 503", p, w.Code, w.Body.String())
		}
	}
}

func TestDataRoutesSay503WhenTheRelayDoesNotAnswer(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	for name, s := range map[string]*Server{
		"relay silent": func() *Server {
			s := setupTestServer(t)
			s.metadata = storeFor(t, newRelayStub(t, "silent").URL, true)
			return s
		}(),
		"never connected": func() *Server {
			s := setupTestServer(t)
			s.metadata = storeFor(t, "ws://127.0.0.1:1", false)
			return s
		}(),
	} {
		for _, p := range dataRoutes {
			if w := ownGet(t, s, sk, p); w.Code != http.StatusServiceUnavailable {
				t.Errorf("%s: %s = %d (%s), want 503", name, p, w.Code, w.Body.String())
			}
		}
	}
}

func TestReadyStaysUpWhileRelayIsDown(t *testing.T) {
	ready := func(s *Server) (int, string, map[string]any) {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("/ready body is not JSON: %q", w.Body.String())
		}
		return w.Code, w.Header().Get("Content-Type"), body
	}
	check := func(name string, s *Server, relay string, gauge float64) {
		t.Helper()
		code, ct, body := ready(s)
		if code != http.StatusOK || ct != "application/json" || body["ready"] != true || body["relay"] != relay {
			t.Fatalf("%s: /ready = %d %s %v, want 200 JSON ready=true relay=%s", name, code, ct, body, relay)
		}
		if got := testutil.ToFloat64(metrics.RelayConnected); got != gauge {
			t.Fatalf("%s: relay gauge = %v, want %v", name, got, gauge)
		}
	}

	s := setupTestServer(t)
	check("no store", s, "not_configured", 0)
	s.metadata = storeFor(t, "ws://127.0.0.1:1", false)
	check("relay down", s, "reconnecting", 0)
	s.metadata = storeFor(t, newRelayStub(t, "none").URL, true)
	check("relay connected", s, "connected", 1)

	// The data routes still say 503 while the relay is down.
	s.metadata = storeFor(t, "ws://127.0.0.1:1", false)
	check("relay down again", s, "reconnecting", 0)
	sk := nostr.GeneratePrivateKey()
	if w := ownGet(t, s, sk, "/api/files?"); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("relay down: /api/files = %d, want 503", w.Code)
	}

	// /health is the liveness probe and does not depend on the relay either.
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("/health = %d, want 200", w.Code)
	}
}
