package auth

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// NIP46Verifier handles NIP-46 authentication verification
type NIP46Verifier struct {
	relayURL      string
	sessionCache  map[string]*SessionToken
	cacheMutex    sync.RWMutex
	cacheTimeout  time.Duration
}

// SessionToken represents a cached authorization token
type SessionToken struct {
	Pubkey    string
	Timestamp time.Time
}

// NewNIP46Verifier creates a new NIP-46 verifier
func NewNIP46Verifier(relayURL string) *NIP46Verifier {
	return &NIP46Verifier{
		relayURL:     relayURL,
		sessionCache: make(map[string]*SessionToken),
		cacheTimeout: 24 * time.Hour,
	}
}

// VerifyEvent verifies that a Nostr event is properly signed
func (v *NIP46Verifier) VerifyEvent(ctx context.Context, event *nostr.Event) (bool, error) {
	if event == nil {
		return false, fmt.Errorf("event is nil")
	}

	// Verify the signature
	ok, err := event.CheckSignature()
	if err != nil {
		log.Printf("Signature verification error: %v", err)
		return false, fmt.Errorf("failed to verify signature: %w", err)
	}

	if !ok {
		return false, fmt.Errorf("signature verification failed")
	}

	// Verify event is not too old (within 5 minutes)
	eventTime := time.Unix(int64(event.CreatedAt), 0)
	if time.Since(eventTime) > 5*time.Minute {
		return false, fmt.Errorf("event timestamp too old")
	}

	return true, nil
}

// VerifyUploadAuthorization verifies that a user is authorized to upload a file
// This checks for a signed event that grants upload permission
func (v *NIP46Verifier) VerifyUploadAuthorization(ctx context.Context, event *nostr.Event, sha256 string) (string, error) {
	// Verify the event signature
	ok, err := v.VerifyEvent(ctx, event)
	if err != nil || !ok {
		return "", fmt.Errorf("failed to verify authorization event")
	}

	// Extract pubkey from event
	pubkey := event.PubKey

	// In a real implementation, you would:
	// 1. Check the event kind (kind 24242 is typical for Blossom auth)
	// 2. Verify the event contains the file hash in its tags
	// 3. Check for any restrictions (expiry, etc)
	// 4. Cache the authorization token

	return pubkey, nil
}

// VerifyDeleteAuthorization verifies that a user is authorized to delete a file
func (v *NIP46Verifier) VerifyDeleteAuthorization(ctx context.Context, event *nostr.Event, sha256 string) (string, error) {
	// Verify the event signature
	ok, err := v.VerifyEvent(ctx, event)
	if err != nil || !ok {
		return "", fmt.Errorf("failed to verify authorization event")
	}

	// Extract pubkey from event
	pubkey := event.PubKey

	// In a real implementation, you would verify the pubkey uploaded the file

	return pubkey, nil
}

// CacheToken caches an authorization token
func (v *NIP46Verifier) CacheToken(pubkey string) string {
	v.cacheMutex.Lock()
	defer v.cacheMutex.Unlock()

	token := fmt.Sprintf("%s-%d", pubkey, time.Now().UnixNano())
	v.sessionCache[token] = &SessionToken{
		Pubkey:    pubkey,
		Timestamp: time.Now(),
	}

	return token
}

// ValidateToken validates a cached authorization token
func (v *NIP46Verifier) ValidateToken(token string) (string, error) {
	v.cacheMutex.RLock()
	defer v.cacheMutex.RUnlock()

	session, ok := v.sessionCache[token]
	if !ok {
		return "", fmt.Errorf("invalid token")
	}

	// Check if token has expired
	if time.Since(session.Timestamp) > v.cacheTimeout {
		return "", fmt.Errorf("token expired")
	}

	return session.Pubkey, nil
}

// ClearOldTokens clears expired tokens from the cache
func (v *NIP46Verifier) ClearOldTokens() {
	v.cacheMutex.Lock()
	defer v.cacheMutex.Unlock()

	now := time.Now()
	for token, session := range v.sessionCache {
		if now.Sub(session.Timestamp) > v.cacheTimeout {
			delete(v.sessionCache, token)
		}
	}
}
