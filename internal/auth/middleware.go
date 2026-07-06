package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/platform"
	"github.com/nbd-wtf/go-nostr"
)

// contextKey is a type for context keys
type contextKey string

const (
	// ContextKeyPubkey is the context key for the authenticated pubkey
	ContextKeyPubkey contextKey = "pubkey"
	// ContextKeyAuthorized is the context key for whitelist authorization status
	ContextKeyAuthorized contextKey = "authorized"
)

// signerSessionEntry is a cached signer-session → pubkey resolution.
type signerSessionEntry struct {
	pubkey  string
	expires time.Time
}

// AuthMiddleware provides authentication and authorization middleware
type AuthMiddleware struct {
	whitelist      *Whitelist
	platformClient *platform.Client
	logger         *slog.Logger

	// signerURL enables unified-auth: the .cloistr.xyz session cookie (or a
	// Bearer signer JWT) is validated against the signer's /users/me and mapped
	// to a pubkey. Empty = disabled (Blossom Nostr-event auth only).
	signerURL   string
	httpClient  *http.Client
	sessionMu   sync.RWMutex
	sessionCache map[string]signerSessionEntry
}

// NewAuthMiddleware creates a new auth middleware
func NewAuthMiddleware(whitelist *Whitelist, signerURL string, logger *slog.Logger) *AuthMiddleware {
	return &AuthMiddleware{
		whitelist:    whitelist,
		logger:       logger,
		signerURL:    signerURL,
		httpClient:   &http.Client{Timeout: 5 * time.Second},
		sessionCache: make(map[string]signerSessionEntry),
	}
}

// NewAuthMiddlewareWithPlatform creates an auth middleware with platform ACL support
func NewAuthMiddlewareWithPlatform(whitelist *Whitelist, platformClient *platform.Client, signerURL string, logger *slog.Logger) *AuthMiddleware {
	return &AuthMiddleware{
		whitelist:      whitelist,
		platformClient: platformClient,
		logger:         logger,
		signerURL:      signerURL,
		httpClient:     &http.Client{Timeout: 5 * time.Second},
		sessionCache:   make(map[string]signerSessionEntry),
	}
}

// AuthResult represents the authentication status
type AuthResult struct {
	Authenticated bool   `json:"authenticated"`
	Pubkey        string `json:"pubkey,omitempty"`
	Authorized    bool   `json:"authorized"`
	Error         string `json:"error,omitempty"`
}

// ExtractPubkey extracts and validates the pubkey from request headers
// Checks both Authorization and X-Blossom-Auth headers
func (m *AuthMiddleware) ExtractPubkey(r *http.Request) (string, error) {
	// Try Authorization header first
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		// Fall back to X-Blossom-Auth
		authHeader = r.Header.Get("X-Blossom-Auth")
	}

	if authHeader != "" {
		return ExtractPubkeyFromAuth(authHeader)
	}

	// Unified-auth fallback: no Blossom Nostr-event header — try the Cloistr
	// signer session (.cloistr.xyz cookie or Bearer signer JWT).
	return m.resolveSignerSession(r), nil
}

// resolveSignerSession validates a Cloistr signer session and returns the
// associated pubkey, or "" if there is none / it can't be validated. It forwards
// the caller's auth_token cookie (or Authorization header) to the signer's
// /api/v1/users/me and reads back the pubkey. Results are cached briefly to keep
// the file-serving hot path fast and to avoid hammering the signer.
func (m *AuthMiddleware) resolveSignerSession(r *http.Request) string {
	if m.signerURL == "" {
		return ""
	}

	// Identify the credential (cookie preferred; Bearer accepted).
	var cacheKey, cookieVal, bearer string
	if c, err := r.Cookie("auth_token"); err == nil && c.Value != "" {
		cookieVal = c.Value
		cacheKey = "c:" + c.Value
	} else if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		bearer = strings.TrimPrefix(h, "Bearer ")
		cacheKey = "b:" + bearer
	} else {
		return ""
	}

	// Cache hit?
	m.sessionMu.RLock()
	if e, ok := m.sessionCache[cacheKey]; ok && time.Now().Before(e.expires) {
		m.sessionMu.RUnlock()
		return e.pubkey
	}
	m.sessionMu.RUnlock()

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, m.signerURL+"/api/v1/users/me", nil)
	if err != nil {
		return ""
	}
	if cookieVal != "" {
		req.AddCookie(&http.Cookie{Name: "auth_token", Value: cookieVal})
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := m.httpClient.Do(req)
	if err != nil {
		m.logger.Warn("signer session validation failed", "error", err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var body struct {
		Pubkey string `json:"pubkey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Pubkey == "" {
		return ""
	}

	m.sessionMu.Lock()
	m.sessionCache[cacheKey] = signerSessionEntry{pubkey: body.Pubkey, expires: time.Now().Add(2 * time.Minute)}
	m.sessionMu.Unlock()

	return body.Pubkey
}

// ExtractPubkeyFromAuth extracts the pubkey from a Nostr auth header
// Format: "Nostr <base64-encoded-signed-event>"
func ExtractPubkeyFromAuth(authHeader string) (string, error) {
	if !strings.HasPrefix(authHeader, "Nostr ") {
		return "", nil
	}

	eventB64 := strings.TrimPrefix(authHeader, "Nostr ")
	eventJSON, err := base64.StdEncoding.DecodeString(eventB64)
	if err != nil {
		return "", err
	}

	var event nostr.Event
	if err := json.Unmarshal(eventJSON, &event); err != nil {
		return "", err
	}

	// Verify the signature
	ok, err := event.CheckSignature()
	if err != nil || !ok {
		return "", err
	}

	return event.PubKey, nil
}

// RequireAuth middleware requires a valid authentication header
func (m *AuthMiddleware) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pubkey, err := m.ExtractPubkey(r)
		if err != nil {
			m.logger.Warn("invalid auth header", "error", err)
			http.Error(w, "Invalid authentication", http.StatusUnauthorized)
			return
		}

		if pubkey == "" {
			http.Error(w, "Authentication required", http.StatusUnauthorized)
			return
		}

		// Add pubkey to context
		ctx := context.WithValue(r.Context(), ContextKeyPubkey, pubkey)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireWhitelist middleware requires authentication AND authorization
// Authorization is checked via platform ACL (if configured) or whitelist (fallback)
func (m *AuthMiddleware) RequireWhitelist(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pubkey, err := m.ExtractPubkey(r)
		if err != nil {
			m.logger.Warn("invalid auth header", "error", err)
			http.Error(w, "Invalid authentication", http.StatusUnauthorized)
			return
		}

		if pubkey == "" {
			http.Error(w, "Authentication required", http.StatusUnauthorized)
			return
		}

		truncated := pubkey
		if len(pubkey) > 16 {
			truncated = pubkey[:16] + "..."
		}

		// Check authorization: platform ACL takes precedence, then whitelist
		var authorized bool

		if m.platformClient != nil {
			// Platform mode: check user_service_access table
			hasAccess, err := m.platformClient.HasAccess(r.Context(), pubkey)
			if err != nil {
				m.logger.Error("platform access check failed",
					"error", err,
					"pubkey", truncated,
				)
				http.Error(w, "Authorization check failed", http.StatusInternalServerError)
				return
			}
			authorized = hasAccess

			if !authorized {
				m.logger.Info("access denied - no platform service access",
					"pubkey", truncated,
				)
				http.Error(w, "Service access required", http.StatusPaymentRequired)
				return
			}
		} else {
			// Standalone mode: use whitelist
			authorized = m.whitelist.IsAllowed(pubkey)

			if !authorized {
				m.logger.Info("access denied - not on whitelist",
					"pubkey", truncated,
				)
				http.Error(w, "Access denied - not authorized", http.StatusForbidden)
				return
			}
		}

		// Add pubkey and authorized status to context
		ctx := context.WithValue(r.Context(), ContextKeyPubkey, pubkey)
		ctx = context.WithValue(ctx, ContextKeyAuthorized, true)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// OptionalAuth middleware extracts auth if present but doesn't require it
func (m *AuthMiddleware) OptionalAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pubkey, _ := m.ExtractPubkey(r)

		ctx := r.Context()
		if pubkey != "" {
			ctx = context.WithValue(ctx, ContextKeyPubkey, pubkey)

			// Check authorization
			var authorized bool
			if m.platformClient != nil {
				hasAccess, _ := m.platformClient.HasAccess(r.Context(), pubkey)
				authorized = hasAccess
			} else {
				authorized = m.whitelist.IsAllowed(pubkey)
			}
			ctx = context.WithValue(ctx, ContextKeyAuthorized, authorized)
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetPubkeyFromContext retrieves the authenticated pubkey from context
func GetPubkeyFromContext(ctx context.Context) string {
	if pubkey, ok := ctx.Value(ContextKeyPubkey).(string); ok {
		return pubkey
	}
	return ""
}

// IsAuthorizedFromContext checks if the user is authorized (on whitelist)
func IsAuthorizedFromContext(ctx context.Context) bool {
	if authorized, ok := ctx.Value(ContextKeyAuthorized).(bool); ok {
		return authorized
	}
	return false
}

// HandleAuthStatus returns the current authentication status
func (m *AuthMiddleware) HandleAuthStatus(w http.ResponseWriter, r *http.Request) {
	result := AuthResult{
		Authenticated: false,
		Authorized:    false,
	}

	pubkey, err := m.ExtractPubkey(r)
	if err != nil {
		result.Error = "Invalid authentication header"
		w.Header().Set("Content-Type", "application/json")
		if encErr := json.NewEncoder(w).Encode(result); encErr != nil {
			m.logger.Warn("failed to encode auth status response", "error", encErr)
		}
		return
	}

	if pubkey != "" {
		result.Authenticated = true
		result.Pubkey = pubkey

		// Check authorization via platform or whitelist
		if m.platformClient != nil {
			hasAccess, _ := m.platformClient.HasAccess(r.Context(), pubkey)
			result.Authorized = hasAccess
		} else {
			result.Authorized = m.whitelist.IsAllowed(pubkey)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if encErr := json.NewEncoder(w).Encode(result); encErr != nil {
		m.logger.Warn("failed to encode auth status response", "error", encErr)
	}
}
