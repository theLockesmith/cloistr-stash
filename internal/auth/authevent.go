package auth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// Accepted auth event kinds. Anything else is refused: a header carrying a
// validly signed but unrelated event (a public kind-0/kind-1 scraped off a
// relay) must not authenticate anyone.
const (
	KindHTTPAuth    = 27235 // NIP-98 HTTP auth
	KindBlossomAuth = 24242 // Blossom (BUD-01/02) upload/delete auth

	// MaxAuthClockSkew bounds NIP-98 created_at in both directions and Blossom
	// created_at in the future direction (NIP-98's 60s).
	MaxAuthClockSkew = 60 * time.Second
)

var (
	ErrAuthFormat      = errors.New("auth: expected 'Nostr <base64-event>'")
	ErrAuthEvent       = errors.New("auth: malformed event")
	ErrAuthSignature   = errors.New("auth: invalid signature")
	ErrAuthKind        = errors.New("auth: event kind not accepted for this route")
	ErrAuthTime        = errors.New("auth: event created_at outside the allowed window")
	ErrAuthURL         = errors.New("auth: 'u' tag does not match the request URL")
	ErrAuthMethod      = errors.New("auth: 'method' tag does not match the request method")
	ErrAuthBlossomOp   = errors.New("auth: 't' tag does not match the blob operation")
	ErrAuthBlossomHash = errors.New("auth: 'x' tag does not match the blob hash")
	ErrAuthExpired     = errors.New("auth: missing or past 'expiration'")
)

func decodeAuthEvent(header string) (*nostr.Event, error) {
	if !strings.HasPrefix(header, "Nostr ") {
		return nil, ErrAuthFormat
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Nostr "))
	if err != nil {
		return nil, ErrAuthEvent
	}
	var ev nostr.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		return nil, ErrAuthEvent
	}
	return &ev, nil
}

func verified(ev *nostr.Event) bool {
	ok, err := ev.CheckSignature()
	return err == nil && ok
}

// ValidateAuthHeader authenticates a `Nostr <base64-event>` header for request
// r and returns the signer's pubkey. It accepts exactly:
//
//   - kind 27235 (NIP-98) on any route: u = this request's URL, method = this
//     request's method, created_at within MaxAuthClockSkew of now;
//   - kind 24242 (Blossom) only on the blob routes: POST /api/files with
//     t=upload, DELETE /api/files/{sha256} with t=delete and x={sha256}; a
//     future 'expiration' is required and created_at may not be in the future.
func ValidateAuthHeader(r *http.Request, header string, now time.Time) (string, error) {
	ev, err := decodeAuthEvent(header)
	if err != nil {
		return "", err
	}
	if !verified(ev) {
		return "", ErrAuthSignature
	}

	switch ev.Kind {
	case KindHTTPAuth:
		if d := now.Sub(ev.CreatedAt.Time()); d > MaxAuthClockSkew || d < -MaxAuthClockSkew {
			return "", ErrAuthTime
		}
		u := tagValue(ev.Tags, "u")
		if u == "" || !strings.EqualFold(strings.TrimSuffix(u, "/"), strings.TrimSuffix(requestURL(r), "/")) {
			return "", ErrAuthURL
		}
		if m := tagValue(ev.Tags, "method"); m == "" || !strings.EqualFold(m, r.Method) {
			return "", ErrAuthMethod
		}
		return ev.PubKey, nil

	case KindBlossomAuth:
		op, sha := blobOperation(r)
		if op == "" {
			return "", ErrAuthKind
		}
		if ev.CreatedAt.Time().Sub(now) > MaxAuthClockSkew {
			return "", ErrAuthTime
		}
		exp, err := strconv.ParseInt(tagValue(ev.Tags, "expiration"), 10, 64)
		if err != nil || !now.Before(time.Unix(exp, 0)) {
			return "", ErrAuthExpired
		}
		if !hasTag(ev.Tags, "t", op) {
			return "", ErrAuthBlossomOp
		}
		if sha != "" && !hasTag(ev.Tags, "x", strings.ToLower(sha)) {
			return "", ErrAuthBlossomHash
		}
		return ev.PubKey, nil
	}
	return "", ErrAuthKind
}

// VerifiedPubkeyFromHeader returns the pubkey of a `Nostr <base64-event>`
// header only if the event's signature verifies, else "". It checks nothing
// else, so use it only where the pubkey selects data the caller may already
// read (GET /api/quota); routes that ACT must use ValidateAuthHeader.
func VerifiedPubkeyFromHeader(header string) string {
	ev, err := decodeAuthEvent(header)
	if err != nil || !verified(ev) {
		return ""
	}
	return ev.PubKey
}

// blobOperation maps the request to its Blossom operation: ("upload", "") for
// POST /api/files, ("delete", sha256) for DELETE /api/files/{sha256}, else "".
func blobOperation(r *http.Request) (op, sha string) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/files":
		return "upload", ""
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/files/"):
		sha = strings.TrimPrefix(r.URL.Path, "/api/files/")
		if sha != "" && !strings.Contains(sha, "/") {
			return "delete", sha
		}
	}
	return "", ""
}

// requestURL rebuilds the URL the client signed (behind the ingress, scheme
// and host come from X-Forwarded-*). Same rule as cloistr-me's NIP-98 check.
func requestURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	path := r.URL.Path
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	return scheme + "://" + host + path
}

func tagValue(tags nostr.Tags, name string) string {
	for _, t := range tags {
		if len(t) >= 2 && t[0] == name {
			return t[1]
		}
	}
	return ""
}

func hasTag(tags nostr.Tags, name, value string) bool {
	for _, t := range tags {
		if len(t) >= 2 && t[0] == name && strings.EqualFold(t[1], value) {
			return true
		}
	}
	return false
}
