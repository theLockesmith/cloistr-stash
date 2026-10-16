package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"path"
	"strings"
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
	// EmbedParents is the space-separated list of exact origins allowed to
	// frame /embed/ pages and to receive their postMessage output. The server
	// sends it as the embed's CSP frame-ancestors; the embed checks its parent
	// against it. Empty means no site may frame the embed.
	EmbedParents string `json:"embedParents"`
}

// defaultEmbedParents is production Space, the only app that frames Stash.
const defaultEmbedParents = "https://space.cloistr.xyz"

// parseEmbedParents keeps only exact origins: https (or http on localhost, for
// development), a host, no path, query, fragment, user info or wildcard. A
// rejected entry is dropped, never widened, so a typo fails closed.
func parseEmbedParents(raw string) string {
	var out []string
	for _, entry := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' }) {
		u, err := url.Parse(entry)
		if err != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" ||
			u.User != nil || u.Opaque != "" || strings.HasSuffix(entry, "?") || strings.HasSuffix(entry, "#") ||
			strings.ContainsAny(u.Host, "*") || strings.HasSuffix(u.Hostname(), ".") {
			continue
		}
		local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"
		if u.Scheme != "https" && !(u.Scheme == "http" && local) {
			continue
		}
		origin := u.Scheme + "://" + strings.ToLower(u.Host)
		if origin != entry {
			// Anything a browser would not send verbatim as an origin
			// (upper case, default port spelled out) is not an exact match.
			continue
		}
		out = append(out, origin)
	}
	return strings.Join(out, " ")
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
		EmbedParents: parseEmbedParents(get("CLOISTR_EMBED_PARENTS", defaultEmbedParents)),
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

// setFrameHeaders decides who may frame a page. Only /embed/ pages may be
// framed, and only by the configured parents; every other page refuses.
func (s *Server) setFrameHeaders(w http.ResponseWriter, path string) {
	if isEmbedPath(path) && s.runtimeConfig.EmbedParents != "" {
		w.Header().Set("Content-Security-Policy", "frame-ancestors "+s.runtimeConfig.EmbedParents)
		return
	}
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	w.Header().Set("X-Frame-Options", "DENY")
}

// isEmbedPath cleans first, so /embed/../ cannot carry the embed's framing
// permission onto the main app.
func isEmbedPath(p string) bool {
	p = path.Clean("/" + p)
	return p == "/embed" || strings.HasPrefix(p, "/embed/")
}
