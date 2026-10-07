package server

import (
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/config"
	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/quota"
	"github.com/nbd-wtf/go-nostr"
)

// GET /api/quota used to return any key's usage for ?pubkey=<hex>. It now
// returns per-user numbers only to that user (orchestrator, 2026-10-07).

func quotaServer(t *testing.T, enabled bool) *Server {
	t.Helper()
	s := setupTestServer(t)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	s.quota = quota.NewManager(config.QuotaConfig{Enabled: enabled, DefaultLimit: 1 << 30}, logger)
	return s
}

func nip98Header(t *testing.T, sk, url, method string) string {
	t.Helper()
	ev := nostr.Event{
		Kind:      27235,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Tags:      nostr.Tags{{"u", url}, {"method", method}},
	}
	if err := ev.Sign(sk); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(ev)
	return "Nostr " + base64.StdEncoding.EncodeToString(raw)
}

func getQuota(s *Server, target, authHeader string) (*httptest.ResponseRecorder, map[string]any) {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	if authHeader != "" {
		r.Header.Set("Authorization", authHeader)
	}
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, r)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w, body
}

func TestQuotaUnauthenticatedRevealsOnlyWhetherEnabled(t *testing.T) {
	victim := nostr.GeneratePrivateKey()
	victimPub, _ := nostr.GetPublicKey(victim)

	s := quotaServer(t, false)
	s.quota.AddUsage(victimPub, 12345)
	w, body := getQuota(s, "/api/quota?pubkey="+victimPub, "")
	if w.Code != http.StatusOK {
		t.Fatalf("disabled, no auth: status %d", w.Code)
	}
	if body["enabled"] != false {
		t.Fatalf("enabled = %v", body["enabled"])
	}
	for _, k := range []string{"used", "limit", "available", "percent", "used_human"} {
		if _, ok := body[k]; ok {
			t.Errorf("unauthenticated response carries %q: %v", k, body)
		}
	}
}

func TestQuotaEnabledRequiresAuth(t *testing.T) {
	victim := nostr.GeneratePrivateKey()
	victimPub, _ := nostr.GetPublicKey(victim)

	s := quotaServer(t, true)
	s.quota.AddUsage(victimPub, 12345)
	for _, target := range []string{"/api/quota", "/api/quota?pubkey=" + victimPub} {
		if w, body := getQuota(s, target, ""); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without auth: status %d body %v", target, w.Code, body)
		}
	}
}

func TestQuotaReturnsCallersOwnUsage(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	pub, _ := nostr.GetPublicKey(sk)
	s := quotaServer(t, true)
	s.quota.AddUsage(pub, 4096)

	w, body := getQuota(s, "/api/quota", nip98Header(t, sk, "http://example.com/api/quota", "GET"))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	if body["enabled"] != true || body["used"] != float64(4096) {
		t.Fatalf("body %v", body)
	}
}

func TestQuotaRefusesSomeoneElsesUsage(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	victim := nostr.GeneratePrivateKey()
	victimPub, _ := nostr.GetPublicKey(victim)
	s := quotaServer(t, true)
	s.quota.AddUsage(victimPub, 12345)

	target := "/api/quota?pubkey=" + victimPub
	w, body := getQuota(s, target, nip98Header(t, sk, "http://example.com"+target, "GET"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status %d body %v", w.Code, body)
	}
}

func TestQuotaRejectsAuthForAnotherURL(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	s := quotaServer(t, true)
	w, _ := getQuota(s, "/api/quota", nip98Header(t, sk, "http://example.com/api/folders", "GET"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", w.Code)
	}
}
