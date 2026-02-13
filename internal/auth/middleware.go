package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

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

// AuthMiddleware provides authentication and authorization middleware
type AuthMiddleware struct {
	whitelist *Whitelist
	logger    *slog.Logger
}

// NewAuthMiddleware creates a new auth middleware
func NewAuthMiddleware(whitelist *Whitelist, logger *slog.Logger) *AuthMiddleware {
	return &AuthMiddleware{
		whitelist: whitelist,
		logger:    logger,
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

	if authHeader == "" {
		return "", nil
	}

	return ExtractPubkeyFromAuth(authHeader)
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

// RequireWhitelist middleware requires authentication AND whitelist membership
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

		// Check whitelist
		if !m.whitelist.IsAllowed(pubkey) {
			m.logger.Info("access denied - not on whitelist",
				"pubkey", pubkey[:16]+"...",
			)
			http.Error(w, "Access denied - not authorized", http.StatusForbidden)
			return
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
			ctx = context.WithValue(ctx, ContextKeyAuthorized, m.whitelist.IsAllowed(pubkey))
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
		json.NewEncoder(w).Encode(result)
		return
	}

	if pubkey != "" {
		result.Authenticated = true
		result.Pubkey = pubkey
		result.Authorized = m.whitelist.IsAllowed(pubkey)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
