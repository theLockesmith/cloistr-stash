package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/blossom"
)

// A Blossom that has every blob: HEAD /<anything> is 200. Like the real one,
// it never sees what follows a '?' in the id, because that becomes a query.
func everyBlobServer(t *testing.T, s *Server) {
	t.Helper()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(b.Close)
	s.blossom = blossom.NewClient(b.URL)
}

const realHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestPublicLinkRefusesAnIDThatIsNotAHash(t *testing.T) {
	s := setupTestServer(t)
	everyBlobServer(t, s)

	for _, p := range []string{
		"/public/" + realHash + "%3F%27;alert(1);%27",     // ?';alert(1)// : passes the existence check
		"/public/%27;alert(document.cookie);%27",          // the reviewer's probe
		"/public/" + realHash + "%3C%2Fscript%3E",         // </script>
		"/public/" + strings.ToUpper(realHash[:63]) + "g", // not hex
		"/public/" + realHash[:63],                        // too short
		"/api/public/" + realHash + "%3F%27;alert(1);%27",
	} {
		w := httptest.NewRecorder()
		s.mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", p, w.Code)
		}
		if strings.Contains(w.Body.String(), "alert") || strings.Contains(w.Body.String(), "</script>") {
			t.Errorf("%s: request text echoed into the page", p)
		}
	}
}

func TestPublicLinkServesARealHashAndRefusesFraming(t *testing.T) {
	s := setupTestServer(t)
	everyBlobServer(t, s)

	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/public/"+realHash, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "const sha256 = '"+realHash+"';") {
		t.Errorf("page does not carry the hash")
	}
	// This page holds the file key (URL fragment); a swapped CDN copy of
	// libsodium must not run on it.
	if !strings.Contains(w.Body.String(), `integrity="sha384-`) {
		t.Errorf("libsodium is loaded without an integrity hash")
	}
	if got := w.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("X-Frame-Options = %q, want DENY", got)
	}
	if got := w.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Errorf("CSP = %q, want frame-ancestors 'none'", got)
	}
}
