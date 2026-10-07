package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envFrom(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestRuntimeConfigDefaultsAreProduction(t *testing.T) {
	got := runtimeConfigFromEnv(envFrom(nil))
	want := RuntimeConfig{
		RelayURL:     "wss://relay.cloistr.xyz",
		BlossomURL:   "https://blossom.cloistr.xyz",
		DiscoveryURL: "https://discover.cloistr.xyz",
		SignerURL:    "https://signer.cloistr.xyz",
		AppURL:       "https://stash.cloistr.xyz",
		Environment:  "production",
	}
	if got != want {
		t.Fatalf("defaults:\n got %+v\nwant %+v", got, want)
	}
}

func TestRuntimeConfigEnvOverrides(t *testing.T) {
	got := runtimeConfigFromEnv(envFrom(map[string]string{
		"CLOISTR_RELAY_URL":     "wss://relay.staging.cloistr.xyz",
		"CLOISTR_BLOSSOM_URL":   "https://blossom.staging.cloistr.xyz",
		"CLOISTR_DISCOVERY_URL": "https://discover.staging.cloistr.xyz",
		"CLOISTR_SIGNER_URL":    "https://signer.staging.cloistr.xyz",
		"CLOISTR_APP_URL":       "https://stash.staging.cloistr.xyz",
		"CLOISTR_ENVIRONMENT":   "staging",
	}))
	want := RuntimeConfig{
		RelayURL:     "wss://relay.staging.cloistr.xyz",
		BlossomURL:   "https://blossom.staging.cloistr.xyz",
		DiscoveryURL: "https://discover.staging.cloistr.xyz",
		SignerURL:    "https://signer.staging.cloistr.xyz",
		AppURL:       "https://stash.staging.cloistr.xyz",
		Environment:  "staging",
	}
	if got != want {
		t.Fatalf("overrides:\n got %+v\nwant %+v", got, want)
	}
}

// configJS fetches /config.js and returns the decoded object plus the response.
func configJS(t *testing.T, s *Server) (map[string]string, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/config.js", nil))
	body := strings.TrimSpace(w.Body.String())
	const prefix = "window.__CLOISTR_CONFIG__="
	if !strings.HasPrefix(body, prefix) || !strings.HasSuffix(body, ";") {
		t.Fatalf("unexpected body: %q", body)
	}
	var got map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(body, prefix), ";")), &got); err != nil {
		t.Fatalf("body is not a JSON assignment: %v (%q)", err, body)
	}
	return got, w
}

func TestConfigJSServesRuntimeConfig(t *testing.T) {
	s := setupTestServer(t)
	s.runtimeConfig = runtimeConfigFromEnv(envFrom(map[string]string{
		"CLOISTR_RELAY_URL":   "wss://relay.staging.cloistr.xyz",
		"CLOISTR_ENVIRONMENT": "staging",
	}))

	got, w := configJS(t, s)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/javascript") {
		t.Errorf("Content-Type = %q", ct)
	}
	// A cached copy would keep serving whichever environment a browser saw first.
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	want := map[string]string{
		"relayUrl":     "wss://relay.staging.cloistr.xyz",
		"blossomUrl":   "https://blossom.cloistr.xyz",
		"discoveryUrl": "https://discover.cloistr.xyz",
		"signerUrl":    "https://signer.cloistr.xyz",
		"appUrl":       "https://stash.cloistr.xyz",
		"environment":  "staging",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func TestConfigJSEscapesScriptBreakout(t *testing.T) {
	s := setupTestServer(t)
	s.runtimeConfig = runtimeConfigFromEnv(envFrom(map[string]string{
		"CLOISTR_ENVIRONMENT": `</script><script>alert(1)</script>`,
	}))
	got, w := configJS(t, s)
	if strings.Contains(w.Body.String(), "</script>") {
		t.Fatalf("raw markup in body: %q", w.Body.String())
	}
	if got["environment"] != `</script><script>alert(1)</script>` {
		t.Fatalf("value not round-tripped: %q", got["environment"])
	}
}

func TestConfigJSWinsOverStaticFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.js"), []byte("STALE"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := setupTestServer(t)
	s.webDir = dir
	s.runtimeConfig = runtimeConfigFromEnv(envFrom(nil))

	got, _ := configJS(t, s)
	if got["environment"] != "production" {
		t.Fatalf("got %v", got)
	}
}
