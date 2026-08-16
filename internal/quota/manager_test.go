package quota

import (
	"io"
	"log/slog"
	"testing"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/config"
)

// The pubkey list changed meaning: it used to gate whether you could upload at
// all (a non-empty list 403'd everyone outside it), and now every signed-in user
// gets the baseline quota while listed pubkeys are exempt. These cover the part
// that decides who pays the limit.

func newManager(t *testing.T, cfg config.QuotaConfig) *Manager {
	t.Helper()
	return NewManager(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

const (
	listed   = "aaaa000000000000000000000000000000000000000000000000000000000001"
	ordinary = "bbbb000000000000000000000000000000000000000000000000000000000002"
)

func TestOrdinaryUserGetsTheBaselineQuota(t *testing.T) {
	m := newManager(t, config.QuotaConfig{
		Enabled:      true,
		DefaultLimit: 100,
	})

	if err := m.CheckQuota(ordinary, 50); err != nil {
		t.Fatalf("an upload inside the baseline must be allowed, got %v", err)
	}
	// This is the behaviour that replaces the old 403: ordinary users CAN
	// upload; they are bounded by quota rather than shut out.
	if err := m.CheckQuota(ordinary, 150); err == nil {
		t.Fatal("an upload beyond the baseline must be refused")
	}
}

func TestListedPubkeyIsUnlimited(t *testing.T) {
	m := newManager(t, config.QuotaConfig{
		Enabled:      true,
		DefaultLimit: 100,
		// main.go seeds a 0 limit for each configured pubkey; 0 means unlimited.
		UserLimits: map[string]int64{listed: 0},
	})

	if err := m.CheckQuota(listed, 1<<40); err != nil {
		t.Fatalf("a listed pubkey must be exempt from the limit, got %v", err)
	}
}

func TestExplicitPerUserLimitIsNotOverriddenByBeingListed(t *testing.T) {
	// main.go only promotes a pubkey to unlimited when no explicit limit exists,
	// so an operator who deliberately capped someone keeps that cap.
	m := newManager(t, config.QuotaConfig{
		Enabled:      true,
		DefaultLimit: 100,
		UserLimits:   map[string]int64{listed: 10},
	})

	if err := m.CheckQuota(listed, 50); err == nil {
		t.Fatal("an explicit per-user limit must still be enforced")
	}
}

func TestQuotaDisabledAllowsEverything(t *testing.T) {
	m := newManager(t, config.QuotaConfig{Enabled: false, DefaultLimit: 1})
	if err := m.CheckQuota(ordinary, 1<<40); err != nil {
		t.Fatalf("with quota disabled nothing should be refused, got %v", err)
	}
}
