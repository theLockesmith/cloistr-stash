package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

func TestPublicLinkServesTheAppAndRefusesFraming(t *testing.T) {
	s := setupTestServer(t)
	everyBlobServer(t, s)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><div id=root></div>"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.webDir = dir

	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/public/"+realHash+"?x=MARKERQ", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	// The web app's own page, with nothing from the request written into it.
	if body := w.Body.String(); body != "<!doctype html><div id=root></div>" {
		t.Errorf("body = %q, want the app's index.html unchanged", body)
	}
	// No hand-written page, so no CDN script either.
	if strings.Contains(w.Body.String(), "cdn.") {
		t.Errorf("page loads from a CDN")
	}
	if got := w.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q, want no-referrer", got)
	}
	if got := w.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("X-Frame-Options = %q, want DENY", got)
	}
	if got := w.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Errorf("CSP = %q, want frame-ancestors 'none'", got)
	}
}

func TestPublicLinkMissingBlobIs404(t *testing.T) {
	s := setupTestServer(t)
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotFound) }))
	t.Cleanup(b.Close)
	s.blossom = blossom.NewClient(b.URL)
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/public/"+realHash, nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404", w.Code)
	}
}
