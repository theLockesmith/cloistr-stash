package server

import (
	"net/http"
	"strings"
)

// CORS for other Cloistr apps (Space calls the files API from
// space.cloistr.xyz). Only origins named in config get any Access-Control-*
// header; an unlisted origin gets none, so its browser blocks the response.
//
// No Allow-Credentials: cross-origin callers authenticate with a signed
// Authorization / X-Blossom-Auth header, never the session cookie, so a
// listed origin still cannot act with the user's cookie.
const (
	corsAllowMethods = "GET, POST, DELETE, OPTIONS"
	corsAllowHeaders = "Authorization, X-Blossom-Auth, Content-Type"
	corsMaxAge       = "600"
)

// corsOriginSet normalises the configured origins (trailing slash dropped).
func corsOriginSet(origins []string) map[string]bool {
	set := make(map[string]bool, len(origins))
	for _, o := range origins {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			set[o] = true
		}
	}
	return set
}

// corsMiddleware answers preflights from listed origins and adds the
// allow-origin header to their other responses.
func corsMiddleware(allowed map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		// The answer depends on Origin, for listed and unlisted alike.
		w.Header().Add("Vary", "Origin")
		if !allowed[origin] {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.Header().Add("Vary", "Access-Control-Request-Method")
			w.Header().Add("Vary", "Access-Control-Request-Headers")
			w.Header().Set("Access-Control-Allow-Methods", corsAllowMethods)
			w.Header().Set("Access-Control-Allow-Headers", corsAllowHeaders)
			w.Header().Set("Access-Control-Max-Age", corsMaxAge)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
