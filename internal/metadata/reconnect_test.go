package metadata

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"
)

// Found live 2026-10-27: main hands Connect a 10s startup timeout, and Connect
// kept it as the base for every reconnect. Once it expired, a pod whose relay
// connection dropped (any relay rollout) failed every reconnect at once with
// "context deadline exceeded", so keyring, file and folder reads answered 500
// for every user on that pod until liveness restarted it.
func TestReconnectOutlivesTheStartupContext(t *testing.T) {
	s := NewStore(fakeRelay(t, "none"), slog.New(slog.NewTextHandler(io.Discard, nil)))
	startup, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := s.Connect(startup); err != nil {
		t.Fatalf("connect: %v", err)
	}
	<-startup.Done()

	// The connection is lost (the relay pod went away). Dropping the reference
	// stands in for that without Store.Close (go-nostr close race, see
	// connectedStore).
	s.connMu.Lock()
	s.relay = nil
	s.connMu.Unlock()

	if err := s.ensureConnected(); err != nil {
		t.Fatalf("reconnect after the startup context expired: %v", err)
	}
	if _, err := s.GetRootKey(context.Background(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err != nil {
		t.Fatalf("root key read after reconnect: %v", err)
	}
}
