package auth

import (
	"sync"
	"time"
)

// replayCacheMax bounds the ids held. Legitimate use is far below it; past it
// new events are refused until old ids expire (at most 2 x MaxAuthClockSkew).
const replayCacheMax = 200_000

// ReplayCache remembers NIP-98 event ids so a captured Authorization header
// cannot be used a second time. An id is kept for twice the accepted clock
// window, after which ValidateAuthHeaderOpts refuses the event on time anyway.
//
// It lives in this process's memory: with several replicas a header can still
// be used once on each replica, and a restart forgets. A shared store (the
// platform database) would close that; see the MR.
type ReplayCache struct {
	mu    sync.Mutex
	seen  map[string]time.Time // id -> forget after
	order []replayEntry        // ids in the order added; live from head on
	head  int
	ttl   time.Duration
	max   int
}

type replayEntry struct {
	id    string
	until time.Time
}

// NewReplayCache keeps ids for 2 x MaxAuthClockSkew.
func NewReplayCache() *ReplayCache {
	return &ReplayCache{seen: make(map[string]time.Time), ttl: 2 * MaxAuthClockSkew, max: replayCacheMax}
}

// Add records id and reports true if it was not seen before. Expired ids are
// pruned from the oldest end, so each call costs the same however many ids
// are held. A full cache refuses new ids rather than forgetting live ones:
// forgetting would let a flood push out a captured header's id and replay it.
func (c *ReplayCache) Add(id string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Every id gets the same ttl, so expiry follows insertion order (an id
	// added with an earlier clock just waits for the ones ahead of it).
	for c.head < len(c.order) && !now.Before(c.order[c.head].until) {
		delete(c.seen, c.order[c.head].id)
		c.order[c.head] = replayEntry{}
		c.head++
	}
	// Compact once the dead prefix is half the slice: amortised constant.
	if c.head > len(c.order)/2 {
		c.order = append(c.order[:0], c.order[c.head:]...)
		c.head = 0
	}
	if _, ok := c.seen[id]; ok {
		return false
	}
	if len(c.seen) >= c.max {
		return false
	}
	until := now.Add(c.ttl)
	c.seen[id] = until
	c.order = append(c.order, replayEntry{id, until})
	return true
}

// Len is the number of ids held (for tests).
func (c *ReplayCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.seen)
}
