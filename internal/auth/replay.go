package auth

import (
	"sync"
	"time"
)

// ReplayCache remembers NIP-98 event ids so a captured Authorization header
// cannot be used a second time. An id is kept for twice the accepted clock
// window, after which ValidateAuthHeaderOpts refuses the event on time anyway.
//
// It lives in this process's memory: with several replicas a header can still
// be used once on each replica, and a restart forgets. A shared store (the
// platform database) would close that; see the MR.
type ReplayCache struct {
	mu   sync.Mutex
	seen map[string]time.Time // id -> forget after
	ttl  time.Duration
}

// NewReplayCache keeps ids for 2 x MaxAuthClockSkew.
func NewReplayCache() *ReplayCache {
	return &ReplayCache{seen: make(map[string]time.Time), ttl: 2 * MaxAuthClockSkew}
}

// Add records id and reports true if it was not seen before. Expired ids are
// pruned on every call.
func (c *ReplayCache) Add(id string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, until := range c.seen {
		if !now.Before(until) {
			delete(c.seen, k)
		}
	}
	if _, ok := c.seen[id]; ok {
		return false
	}
	c.seen[id] = now.Add(c.ttl)
	return true
}

// Len is the number of ids held (for tests).
func (c *ReplayCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.seen)
}
