package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strings"
	"unicode"
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

// embedOrigin is the only shape an embed parent may take: https://host[:port],
// or http on localhost for development. Lower case, no trailing dot, no path,
// and none of ; , ' " * or whitespace, so a configured value can never add a
// directive or source to the frame-ancestors header it is written into.
var embedOrigin = regexp.MustCompile(
	`^(https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*` +
		`|http://(?:localhost|127\.0\.0\.1))(?::[0-9]{1,5})?$`)

// parseEmbedParents accepts exact origins separated by commas or whitespace
// and refuses the whole list if any entry is anything else, so a typo or an
// injection attempt stops the server at startup instead of being served.
func parseEmbedParents(raw string) (string, error) {
	var out []string
	for _, entry := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }) {
		if !embedOrigin.MatchString(entry) {
			return "", fmt.Errorf("CLOISTR_EMBED_PARENTS: %q is not an exact origin (https://host[:port])", entry)
		}
		out = append(out, entry)
	}
	return strings.Join(out, " "), nil
}

func runtimeConfigFromEnv(getenv func(string) string) (RuntimeConfig, error) {
	get := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}
	parents, err := parseEmbedParents(get("CLOISTR_EMBED_PARENTS", defaultEmbedParents))
	if err != nil {
		return RuntimeConfig{}, err
	}
	return RuntimeConfig{
		RelayURL:     get("CLOISTR_RELAY_URL", "wss://relay.cloistr.xyz"),
		BlossomURL:   get("CLOISTR_BLOSSOM_URL", "https://blossom.cloistr.xyz"),
		DiscoveryURL: get("CLOISTR_DISCOVERY_URL", "https://discover.cloistr.xyz"),
		SignerURL:    get("CLOISTR_SIGNER_URL", "https://signer.cloistr.xyz"),
		AppURL:       get("CLOISTR_APP_URL", "https://stash.cloistr.xyz"),
		Environment:  get("CLOISTR_ENVIRONMENT", "production"),
		EmbedParents: parents,
	}, nil
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
