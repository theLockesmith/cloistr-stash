package auth

import (
	"bufio"
	"os"
	"strings"
	"sync"
)

// Whitelist manages a list of authorized pubkeys
type Whitelist struct {
	pubkeys map[string]bool
	mu      sync.RWMutex
}

// NewWhitelist creates a new whitelist from a slice of pubkeys
func NewWhitelist(pubkeys []string) *Whitelist {
	w := &Whitelist{
		pubkeys: make(map[string]bool),
	}
	for _, pk := range pubkeys {
		pk = strings.TrimSpace(pk)
		if pk != "" {
			w.pubkeys[pk] = true
		}
	}
	return w
}

// LoadFromFile loads pubkeys from a file (one per line)
func (w *Whitelist) LoadFromFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	w.mu.Lock()
	defer w.mu.Unlock()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		w.pubkeys[line] = true
	}

	return scanner.Err()
}

// LoadFromEnv loads pubkeys from an environment variable (comma-separated)
func (w *Whitelist) LoadFromEnv(envVar string) {
	value := os.Getenv(envVar)
	if value == "" {
		return
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	for _, pk := range strings.Split(value, ",") {
		pk = strings.TrimSpace(pk)
		if pk != "" {
			w.pubkeys[pk] = true
		}
	}
}

// IsAllowed checks if a pubkey is on the whitelist
// If the whitelist is empty, all pubkeys are allowed (open access mode)
func (w *Whitelist) IsAllowed(pubkey string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()

	// Empty whitelist = allow all (open access mode)
	if len(w.pubkeys) == 0 {
		return true
	}

	return w.pubkeys[pubkey]
}

// Add adds a pubkey to the whitelist
func (w *Whitelist) Add(pubkey string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pubkeys[pubkey] = true
}

// Remove removes a pubkey from the whitelist
func (w *Whitelist) Remove(pubkey string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.pubkeys, pubkey)
}

// List returns all whitelisted pubkeys
func (w *Whitelist) List() []string {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]string, 0, len(w.pubkeys))
	for pk := range w.pubkeys {
		result = append(result, pk)
	}
	return result
}

// Count returns the number of whitelisted pubkeys
func (w *Whitelist) Count() int {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return len(w.pubkeys)
}

// IsEmpty returns true if the whitelist has no entries
func (w *Whitelist) IsEmpty() bool {
	return w.Count() == 0
}
