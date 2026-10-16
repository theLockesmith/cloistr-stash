package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// 2026-10-15: a pod that started during a relay outage kept a nil metadata
// store for 3 hours, answered half of all list requests with an EMPTY list
// ("you have no files") and panicked on /api/keyring. Every data route must
// say 503 instead, and readiness must keep such a pod out of rotation.

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

func TestReadyOnlyWithARelayConnection(t *testing.T) {
	ready := func(s *Server) (int, map[string]any) {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		return w.Code, body
	}

	s := setupTestServer(t)
	if code, _ := ready(s); code != http.StatusServiceUnavailable {
		t.Fatalf("no store: /ready = %d, want 503", code)
	}
	s.metadata = storeFor(t, "ws://127.0.0.1:1", false)
	if code, _ := ready(s); code != http.StatusServiceUnavailable {
		t.Fatalf("unconnected store: /ready = %d, want 503", code)
	}
	s.metadata = storeFor(t, newRelayStub(t, "none").URL, true)
	if code, body := ready(s); code != http.StatusOK || body["relay"] != true {
		t.Fatalf("connected: /ready = %d %v, want 200 relay=true", code, body)
	}
	// /health stays the liveness probe: it does not fail just because the
	// relay is not connected yet (that would restart-loop pods in an outage).
	s.metadata = storeFor(t, "ws://127.0.0.1:1", false)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("/health = %d, want 200", w.Code)
	}
}
