package auth

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const stashOrigin = "https://stash.cloistr.xyz"

// cloistr-pr 2026-10-15: the expected URL was rebuilt from client-controlled
// Host / X-Forwarded-* and compared case-insensitively. With configured
// origins, only origin + exact path + query counts.
func TestNIP98ConfiguredOriginIsExact(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	pk, _ := nostr.GetPublicKey(sk)
	now := time.Now()
	opts := ValidateOptions{Origins: []string{stashOrigin, "https://drive.cloistr.xyz"}}

	spoofed := func(target string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, target, nil)
		r.Host = "evil.example"
		r.Header.Set("X-Forwarded-Host", "evil.example")
		r.Header.Set("X-Forwarded-Proto", "https")
		return r
	}
	ok := func(u, target string) error {
		_, err := ValidateAuthHeaderOpts(spoofed(target), header(t, signed(t, sk, 27235, now, nip98Tags(u, "GET"))), now, opts)
		return err
	}

	if err := ok(stashOrigin+"/api/files?pubkey="+pk, "/api/files?pubkey="+pk); err != nil {
		t.Fatalf("own origin refused: %v", err)
	}
	if err := ok("https://drive.cloistr.xyz/api/files", "/api/files"); err != nil {
		t.Fatalf("second configured origin refused: %v", err)
	}
	for name, c := range map[string][2]string{
		"event signed for another service, Host spoofed to match": {"https://evil.example/api/files", "/api/files"},
		"origin differs in case":  {"https://STASH.cloistr.xyz/api/files", "/api/files"},
		"path differs in case":    {stashOrigin + "/API/files", "/api/files"},
		"trailing slash":          {stashOrigin + "/api/files/", "/api/files"},
		"different query":         {stashOrigin + "/api/files?pubkey=a", "/api/files?pubkey=b"},
		"query dropped":           {stashOrigin + "/api/files", "/api/files?pubkey=a"},
		"http scheme":             {"http://stash.cloistr.xyz/api/files", "/api/files"},
	} {
		if err := ok(c[0], c[1]); !errors.Is(err, ErrAuthURL) {
			t.Fatalf("%s: want ErrAuthURL, got %v", name, err)
		}
	}
}

// cloistr-pr 2026-10-15: no replay store, so a captured header worked for 60s.
func TestNIP98ReplayRefused(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	now := time.Now()
	opts := ValidateOptions{Origins: []string{stashOrigin}, Replay: NewReplayCache()}
	h := header(t, signed(t, sk, 27235, now, nip98Tags(stashOrigin+"/api/files", "GET")))
	r := func() *http.Request { return httptest.NewRequest(http.MethodGet, "/api/files", nil) }

	if _, err := ValidateAuthHeaderOpts(r(), h, now, opts); err != nil {
		t.Fatalf("first use refused: %v", err)
	}
	if _, err := ValidateAuthHeaderOpts(r(), h, now.Add(time.Second), opts); !errors.Is(err, ErrAuthReplay) {
		t.Fatalf("second use: want ErrAuthReplay, got %v", err)
	}

	// An event refused for another reason is not recorded, so it does not
	// poison the cache for nothing.
	bad := header(t, signed(t, sk, 27235, now, nip98Tags(stashOrigin+"/api/other", "GET")))
	before := opts.Replay.Len()
	if _, err := ValidateAuthHeaderOpts(r(), bad, now, opts); !errors.Is(err, ErrAuthURL) {
		t.Fatalf("want ErrAuthURL, got %v", err)
	}
	if opts.Replay.Len() != before {
		t.Fatal("a refused event was recorded")
	}
}

func TestReplayCacheExpiresAndPrunes(t *testing.T) {
	c := NewReplayCache()
	t0 := time.Unix(1_700_000_000, 0)
	if !c.Add("a", t0) {
		t.Fatal("first add")
	}
	if c.Add("a", t0.Add(2*MaxAuthClockSkew-time.Second)) {
		t.Fatal("seen id accepted inside the window")
	}
	// Past 2x the window the id is pruned on the next call.
	if !c.Add("b", t0.Add(2*MaxAuthClockSkew)) || c.Len() != 1 {
		t.Fatalf("expired id not pruned, len %d", c.Len())
	}
}

func TestMiddlewareSetHTTPAuthRefusesReplay(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	m := NewAuthMiddleware(NewWhitelist(nil), "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	m.SetHTTPAuth([]string{stashOrigin})
	h := m.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	auth := header(t, signed(t, sk, 27235, time.Now(), nip98Tags(stashOrigin+"/api/files", "GET")))
	codes := []int{}
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest(http.MethodGet, "/api/files", nil)
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		codes = append(codes, w.Code)
	}
	if codes[0] != http.StatusOK || codes[1] != http.StatusUnauthorized {
		t.Fatalf("want 200 then 401, got %v", codes)
	}
}
