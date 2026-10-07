package auth

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const testHost = "stash.example"

func signed(t *testing.T, sk string, kind int, createdAt time.Time, tags nostr.Tags) *nostr.Event {
	t.Helper()
	ev := &nostr.Event{Kind: kind, CreatedAt: nostr.Timestamp(createdAt.Unix()), Tags: tags, Content: ""}
	if err := ev.Sign(sk); err != nil {
		t.Fatalf("sign: %v", err)
	}
	return ev
}

func header(t *testing.T, ev *nostr.Event) string {
	t.Helper()
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	return "Nostr " + base64.StdEncoding.EncodeToString(b)
}

func req(method, path string) *http.Request {
	r := httptest.NewRequest(method, "http://"+testHost+path, nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	return r
}

func nip98Tags(url, method string) nostr.Tags {
	return nostr.Tags{{"u", url}, {"method", method}}
}

func blossomTags(op, x string, exp time.Time) nostr.Tags {
	tags := nostr.Tags{{"t", op}, {"expiration", strconv.FormatInt(exp.Unix(), 10)}}
	if x != "" {
		tags = append(tags, nostr.Tag{"x", x})
	}
	return tags
}

func TestValidateAuthHeader(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	pk, _ := nostr.GetPublicKey(sk)
	now := time.Now()
	sha := "a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
	url := func(p string) string { return "https://" + testHost + p }

	tamperedSig := signed(t, sk, 27235, now, nip98Tags(url("/api/folders"), "POST"))
	tamperedSig.Content = "changed after signing"

	cases := []struct {
		name   string
		r      *http.Request
		ev     *nostr.Event
		wantOK bool
	}{
		// The reported attack: a public kind-1 replayed as auth.
		{"REPLAY public kind 1 on metadata", req("POST", "/api/metadata"), signed(t, sk, 1, now.Add(-time.Hour), nil), false},
		{"REPLAY public kind 0 on folders", req("POST", "/api/folders"), signed(t, sk, 0, now.Add(-time.Hour), nil), false},
		{"REPLAY public kind 1 on upload", req("POST", "/api/files"), signed(t, sk, 1, now, nil), false},

		// NIP-98
		{"nip98 ok", req("POST", "/api/folders"), signed(t, sk, 27235, now, nip98Tags(url("/api/folders"), "POST")), true},
		{"nip98 ok with query", req("GET", "/api/auth/status?x=1"), signed(t, sk, 27235, now, nip98Tags(url("/api/auth/status?x=1"), "GET")), true},
		{"nip98 wrong method", req("POST", "/api/folders"), signed(t, sk, 27235, now, nip98Tags(url("/api/folders"), "GET")), false},
		{"nip98 wrong url (other route)", req("POST", "/api/shares"), signed(t, sk, 27235, now, nip98Tags(url("/api/folders"), "POST")), false},
		{"nip98 wrong host", req("POST", "/api/folders"), signed(t, sk, 27235, now, nip98Tags("https://evil.example/api/folders", "POST")), false},
		{"nip98 missing u", req("POST", "/api/folders"), signed(t, sk, 27235, now, nostr.Tags{{"method", "POST"}}), false},
		{"nip98 too old", req("POST", "/api/folders"), signed(t, sk, 27235, now.Add(-2*time.Minute), nip98Tags(url("/api/folders"), "POST")), false},
		{"nip98 in future", req("POST", "/api/folders"), signed(t, sk, 27235, now.Add(2*time.Minute), nip98Tags(url("/api/folders"), "POST")), false},
		{"nip98 bad signature", req("POST", "/api/folders"), tamperedSig, false},

		// Blossom 24242 on blob routes only
		{"24242 upload ok", req("POST", "/api/files"), signed(t, sk, 24242, now, blossomTags("upload", sha, now.Add(5*time.Minute))), true},
		{"24242 delete ok", req("DELETE", "/api/files/"+sha), signed(t, sk, 24242, now, blossomTags("delete", sha, now.Add(5*time.Minute))), true},
		{"24242 delete wrong x", req("DELETE", "/api/files/"+sha), signed(t, sk, 24242, now, blossomTags("delete", "ff"+sha[2:], now.Add(5*time.Minute))), false},
		{"24242 delete missing x", req("DELETE", "/api/files/"+sha), signed(t, sk, 24242, now, blossomTags("delete", "", now.Add(5*time.Minute))), false},
		{"24242 upload token used for delete", req("DELETE", "/api/files/"+sha), signed(t, sk, 24242, now, blossomTags("upload", sha, now.Add(5*time.Minute))), false},
		{"24242 expired", req("POST", "/api/files"), signed(t, sk, 24242, now.Add(-10*time.Minute), blossomTags("upload", sha, now.Add(-5*time.Minute))), false},
		{"24242 missing expiration", req("POST", "/api/files"), signed(t, sk, 24242, now, nostr.Tags{{"t", "upload"}}), false},
		{"24242 created in future", req("POST", "/api/files"), signed(t, sk, 24242, now.Add(5*time.Minute), blossomTags("upload", sha, now.Add(10*time.Minute))), false},
		{"24242 not accepted on metadata route", req("POST", "/api/metadata"), signed(t, sk, 24242, now, blossomTags("upload", sha, now.Add(5*time.Minute))), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateAuthHeader(tc.r, header(t, tc.ev), now)
			if tc.wantOK {
				if err != nil || got != pk {
					t.Fatalf("want accepted as %s, got %q err=%v", pk[:8], got, err)
				}
			} else if err == nil || got != "" {
				t.Fatalf("want refused, got %q err=%v", got, err)
			}
		})
	}
}

func TestValidateAuthHeaderMalformed(t *testing.T) {
	for _, h := range []string{"Nostr !!!notbase64", "Nostr " + base64.StdEncoding.EncodeToString([]byte("{not json"))} {
		if pk, err := ValidateAuthHeader(req("POST", "/api/folders"), h, time.Now()); err == nil || pk != "" {
			t.Fatalf("malformed header %q accepted", h)
		}
	}
}

func TestRequireWhitelistRefusesReplay(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	m := NewAuthMiddleware(NewWhitelist(nil), "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	reached := false
	h := m.RequireWhitelist(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))

	// Replay of a public kind-1: refused before the handler.
	r := req("POST", "/api/folders")
	r.Header.Set("Authorization", header(t, signed(t, sk, 1, time.Now().Add(-time.Hour), nil)))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || reached {
		t.Fatalf("replay: want 401 and handler not reached, got %d reached=%v", w.Code, reached)
	}

	// Correct NIP-98: reaches the handler with the verified pubkey in context.
	pk, _ := nostr.GetPublicKey(sk)
	var ctxPubkey string
	h = m.RequireWhitelist(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctxPubkey = GetPubkeyFromContext(r.Context())
	}))
	r = req("POST", "/api/folders")
	r.Header.Set("Authorization", header(t, signed(t, sk, 27235, time.Now(), nip98Tags("https://"+testHost+"/api/folders", "POST"))))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if ctxPubkey != pk {
		t.Fatalf("nip98: want handler reached as %s, got %q (status %d)", pk[:8], ctxPubkey, w.Code)
	}
}

func TestVerifiedPubkeyFromHeader(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	pk, _ := nostr.GetPublicKey(sk)
	ev := signed(t, sk, 24242, time.Now(), blossomTags("upload", "", time.Now().Add(time.Minute)))
	if got := VerifiedPubkeyFromHeader(header(t, ev)); got != pk {
		t.Fatalf("valid signature: want %s got %q", pk[:8], got)
	}
	// Unsigned claim of someone else's pubkey (the old quota path trusted this).
	forged := *ev
	forged.PubKey = "f" + pk[1:]
	if got := VerifiedPubkeyFromHeader(header(t, &forged)); got != "" {
		t.Fatalf("forged pubkey accepted: %q", got)
	}
}
