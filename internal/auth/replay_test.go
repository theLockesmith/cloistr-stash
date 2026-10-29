package auth

import (
	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/metrics"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"math"
	"strconv"
	"testing"
	"time"
)

// Speed is checked as a ratio, not against the clock, so a slow or busy CI
// runner (and -race) cannot fail it: 4x the ids must cost about 4x the time.
// Linear code lands near 4x; code whose per-call cost grows with the ids held
// lands near 16x. maxGrowth sits between.
const maxGrowth = 8.0

// addsTook times n fresh Adds spaced so the window holds n/per ids, best of
// three runs, and reports how many ids the cache held at the end.
func addsTook(t *testing.T, n, per int) (time.Duration, int) {
	t.Helper()
	best, held := time.Duration(math.MaxInt64), 0
	step := 2 * MaxAuthClockSkew * time.Duration(per) / time.Duration(n)
	for r := 0; r < 3; r++ {
		c := NewReplayCache()
		t0 := time.Unix(1_700_000_000, 0)
		start := time.Now()
		for i := 0; i < n; i++ {
			if !c.Add(strconv.Itoa(i), t0.Add(time.Duration(i)*step)) {
				t.Fatalf("fresh id %d refused", i)
			}
		}
		if d := time.Since(start); d < best {
			best = d
		}
		held = c.Len()
	}
	return best, held
}

func assertLinear(t *testing.T, what string, per int) (small, large int) {
	t.Helper()
	d1, h1 := addsTook(t, 25_000, per)
	d4, h4 := addsTook(t, 100_000, per)
	if g := float64(d4) / float64(d1); g > maxGrowth {
		t.Fatalf("%s: 4x the ids took %.1fx the time (%v vs %v), want under %.0fx", what, g, d4, d1, maxGrowth)
	}
	return h1, h4
}

// cloistr-audit 2026-10-29: Add pruned by scanning every held id, so one
// window of 40k ids (free to mint, since keys are free) cost 12s of CPU under
// the one mutex. Each call must cost the same however many ids are held.
func TestReplayCacheLargeWindowIsLinear(t *testing.T) {
	if _, held := assertLinear(t, "one window", 1); held != 100_000 {
		t.Fatalf("window holds %d ids, want all 100k", held)
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
	if _, held := assertLinear(t, "steady window", 4); held < 24_000 || held > 25_001 {
		t.Fatalf("window holds %d ids, want about 25k", held)
	}
}
