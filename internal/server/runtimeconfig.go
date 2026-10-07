package server

import (
	"encoding/json"
	"net/http"
)

// RuntimeConfig is the service configuration the web app reads at load time
// from /config.js, so one image can serve production and staging.
//
// It is the Go equivalent of the nginx template in collab-common's
// docs/runtime-config-adoption.md: the same CLOISTR_* variables, the same
// window.__CLOISTR_CONFIG__ global, production values when a variable is
// unset (so an image given no configuration behaves exactly as before).
type RuntimeConfig struct {
	RelayURL     string `json:"relayUrl"`
	BlossomURL   string `json:"blossomUrl"`
	DiscoveryURL string `json:"discoveryUrl"`
	SignerURL    string `json:"signerUrl"`
	AppURL       string `json:"appUrl"`
	Environment  string `json:"environment"`
}

func runtimeConfigFromEnv(getenv func(string) string) RuntimeConfig {
	get := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}
	return RuntimeConfig{
		RelayURL:     get("CLOISTR_RELAY_URL", "wss://relay.cloistr.xyz"),
		BlossomURL:   get("CLOISTR_BLOSSOM_URL", "https://blossom.cloistr.xyz"),
		DiscoveryURL: get("CLOISTR_DISCOVERY_URL", "https://discover.cloistr.xyz"),
		SignerURL:    get("CLOISTR_SIGNER_URL", "https://signer.cloistr.xyz"),
		AppURL:       get("CLOISTR_APP_URL", "https://stash.cloistr.xyz"),
		Environment:  get("CLOISTR_ENVIRONMENT", "production"),
	}
}

// handleConfigJS serves window.__CLOISTR_CONFIG__.
//
// no-store: a cached copy (browser or edge) would keep serving whichever
// environment it saw first. encoding/json escapes <, > and &, so a value
// cannot close the script element it is loaded into.
func (s *Server) handleConfigJS(w http.ResponseWriter, r *http.Request) {
	body, err := json.Marshal(s.runtimeConfig)
	if err != nil {
		http.Error(w, "config unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte("window.__CLOISTR_CONFIG__="))
	_, _ = w.Write(body)
	_, _ = w.Write([]byte(";\n"))
}
