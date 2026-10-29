package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// GET /api/files used to list any ?pubkey='s file metadata to anyone. It now
// lists only the authenticated caller's own (orchestrator, 2026-10-15).

func pub(sk string) string {
	pk, _ := nostr.GetPublicKey(sk)
	return pk
}

func listFiles(s *Server, target, authHeader string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	if authHeader != "" {
		r.Header.Set("Authorization", authHeader)
	}
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, r)
	return w
}

func TestListFilesAnonymousIs401(t *testing.T) {
	s := setupTestServer(t)
	other := pub(nostr.GeneratePrivateKey())
	for _, target := range []string{"/api/files", "/api/files?pubkey=" + other, "/api/files?pubkey=" + other + "&folder="} {
		if w := listFiles(s, target, ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("%s anonymous = %d, want 401", target, w.Code)
		}
	}
}

func TestListFilesOtherPubkeyIs403(t *testing.T) {
	s := setupTestServer(t)
	sk := nostr.GeneratePrivateKey()
	other := pub(nostr.GeneratePrivateKey())
	target := "/api/files?pubkey=" + other
	if w := listFiles(s, target, nip98Header(t, sk, "http://example.com"+target, "GET")); w.Code != http.StatusForbidden {
		t.Fatalf("other pubkey = %d, want 403", w.Code)
	}
}

func TestListFilesOwnPubkeyIs200(t *testing.T) {
	s := setupTestServer(t)
	s.metadata = storeFor(t, newRelayStub(t, "none").URL, true)
	sk := nostr.GeneratePrivateKey()
	me := pub(sk)
	for _, target := range []string{"/api/files?pubkey=" + me, "/api/files?pubkey=" + me + "&folder=", "/api/files"} {
		w := listFiles(s, target, nip98Header(t, sk, "http://example.com"+target, "GET"))
		if w.Code != http.StatusOK {
			t.Fatalf("%s own = %d (%s), want 200", target, w.Code, w.Body.String())
		}
		var body struct {
			Files []any `json:"files"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Files == nil {
			t.Fatalf("%s: body %q", target, w.Body.String())
		}
	}
}

func TestListFilesRejectsAuthSignedForAnotherRequest(t *testing.T) {
	s := setupTestServer(t)
	sk := nostr.GeneratePrivateKey()
	me := pub(sk)
	target := "/api/files?pubkey=" + me
	for name, h := range map[string]string{
		"other URL":    nip98Header(t, sk, "http://example.com/api/files?pubkey="+me+"&folder=x", "GET"),
		"other method": nip98Header(t, sk, "http://example.com"+target, "DELETE"),
		"garbage":      "Nostr not-base64!",
	} {
		if w := listFiles(s, target, h); w.Code != http.StatusUnauthorized {
			t.Fatalf("%s = %d, want 401", name, w.Code)
		}
	}
}

func TestGetFileMetadataAnonymousIs401(t *testing.T) {
	s := setupTestServer(t)
	if w := listFiles(s, "/api/files/"+testSHA256, ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous GET /api/files/{sha256} = %d, want 401", w.Code)
	}
}
