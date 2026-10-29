package auth

import (
	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/metrics"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"strconv"
	"testing"
	"time"
)

// cloistr-audit 2026-10-29: Add pruned by scanning every held id, so one
// window of 40k ids (free to mint, since keys are free) cost 12s of CPU under
// the one mutex. Each call must cost the same however many ids are held.
func TestReplayCacheLargeWindowIsLinear(t *testing.T) {
	c := NewReplayCache()
	t0 := time.Unix(1_700_000_000, 0)
	start := time.Now()
	for i := 0; i < 50_000; i++ {
		if !c.Add(strconv.Itoa(i), t0.Add(time.Duration(i)*time.Millisecond)) {
			t.Fatalf("fresh id %d refused", i)
		}
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("50k ids in one window took %v", d)
	}
}

// A full cache must not lock real users out (audit of !232: a 200k-id flood
// refused every fresh request for 121s). It forgets its oldest id instead, so
// replaying a header still needs it captured inside the window AND pushed out
// by a flood, and it counts each eviction so a flood shows on /metrics.
func TestReplayCacheFullEvictsOldestAndAcceptsFreshIDs(t *testing.T) {
	c := NewReplayCache()
	c.max = 3
	before := testutil.ToFloat64(metrics.ReplayEvictionsTotal)
	t0 := time.Unix(1_700_000_000, 0)
	for _, id := range []string{"a", "b", "c"} {
		if !c.Add(id, t0) {
			t.Fatalf("add %s", id)
		}
	}
	if !c.Add("user", t0.Add(time.Second)) {
		t.Fatal("a full cache refused a real user's fresh id")
	}
	if c.Len() != 3 {
		t.Fatalf("len %d, want 3", c.Len())
	}
	for _, id := range []string{"b", "c", "user"} {
		if c.Add(id, t0.Add(2*time.Second)) {
			t.Fatalf("held id %s was accepted again", id)
		}
	}
	if got := testutil.ToFloat64(metrics.ReplayEvictionsTotal) - before; got != 1 {
		t.Fatalf("evictions counted %v, want 1", got)
	}
	// Expiry still works alongside eviction.
	if !c.Add("d", t0.Add(time.Second+2*MaxAuthClockSkew)) || c.Len() != 1 {
		t.Fatalf("after expiry: len %d", c.Len())
	}
}

// Steady traffic: every call expires one id and adds one, with a full window
// held. Pruning must not copy the window on each call.
func TestReplayCacheSteadyStateIsLinear(t *testing.T) {
	c := NewReplayCache()
	t0 := time.Unix(1_700_000_000, 0)
	step := 2 * MaxAuthClockSkew / 50_000
	start := time.Now()
	for i := 0; i < 200_000; i++ {
		if !c.Add(strconv.Itoa(i), t0.Add(time.Duration(i)*step)) {
			t.Fatalf("fresh id %d refused", i)
		}
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("200k ids at a steady 50k-id window took %v", d)
	}
	if n := c.Len(); n < 49_000 || n > 50_001 {
		t.Fatalf("window holds %d ids, want about 50k", n)
	}
}
