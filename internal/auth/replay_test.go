package auth

import (
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

// A full cache refuses new ids rather than forgetting live ones: forgetting
// would let a flood push a captured header's id out and then replay it.
func TestReplayCacheFullRefusesUntilIdsExpire(t *testing.T) {
	c := NewReplayCache()
	c.max = 3
	t0 := time.Unix(1_700_000_000, 0)
	for _, id := range []string{"a", "b", "c"} {
		if !c.Add(id, t0) {
			t.Fatalf("add %s", id)
		}
	}
	if c.Add("d", t0.Add(time.Second)) {
		t.Fatal("a full cache accepted a new id")
	}
	if c.Add("a", t0.Add(time.Second)) {
		t.Fatal("a held id was accepted again")
	}
	if c.Len() != 3 {
		t.Fatalf("len %d, want 3", c.Len())
	}
	// Once the window has passed the old ids go and new ones are accepted.
	if !c.Add("d", t0.Add(2*MaxAuthClockSkew)) || c.Len() != 1 {
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
