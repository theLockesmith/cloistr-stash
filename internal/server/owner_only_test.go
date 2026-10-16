package server

import (
	"net/http"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// Every read route that takes a pubkey answers only its owner (2026-10-15
// audit): anonymous 401, someone else's pubkey 403, own pubkey passes the
// gate (200 for lists; 503 here for the two that need a metadata store).
func TestReadRoutesAreOwnerOnly(t *testing.T) {
	routes := []struct {
		path      string // pubkey appended as ?pubkey= / &pubkey=
		ownStatus int
	}{
		{"/api/files?", http.StatusOK},
		{"/api/files?folder=&", http.StatusOK},
		{"/api/folders?", http.StatusOK},
		{"/api/folders?parent=x&", http.StatusOK},
		{"/api/folders/some-folder?", http.StatusServiceUnavailable},
		{"/api/shares?", http.StatusOK},
		{"/api/shares?type=received&", http.StatusOK},
		{"/api/keyring?", http.StatusServiceUnavailable},
	}
	s := setupTestServer(t)
	sk := nostr.GeneratePrivateKey()
	me := pub(sk)
	other := pub(nostr.GeneratePrivateKey())

	for _, rt := range routes {
		anon := rt.path + "pubkey=" + me
		if w := listFiles(s, anon, ""); w.Code != http.StatusUnauthorized {
			t.Errorf("%s anonymous = %d, want 401", rt.path, w.Code)
		}
		theirs := rt.path + "pubkey=" + other
		if w := listFiles(s, theirs, nip98Header(t, sk, "http://example.com"+theirs, "GET")); w.Code != http.StatusForbidden {
			t.Errorf("%s other pubkey = %d, want 403", rt.path, w.Code)
		}
		mine := rt.path + "pubkey=" + me
		if w := listFiles(s, mine, nip98Header(t, sk, "http://example.com"+mine, "GET")); w.Code != rt.ownStatus {
			t.Errorf("%s own pubkey = %d (%s), want %d", rt.path, w.Code, w.Body.String(), rt.ownStatus)
		}
	}
}
