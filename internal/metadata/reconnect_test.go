package metadata

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A store whose first connect failed must reconnect on its own once the relay
// is back (2026-10-15: main set the store to nil and nothing retried).
func TestKeepConnectedRecovers(t *testing.T) {
	// Point the store at a port with nothing listening, then start a relay there.
	ln := httptest.NewUnstartedServer(nil)
	addr := ln.Listener.Addr().String()
	url := "ws://" + addr
	ln.Close() // free the port; the first connect fails

	s := NewStore(url, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := s.Connect(ctx); err == nil {
		t.Fatal("connect to a closed port succeeded")
	}
	if s.IsConnected() {
		t.Fatal("IsConnected after a failed connect")
	}
	if _, err := s.ListFiles(context.Background(), strings.Repeat("a", 64)); err == nil {
		t.Fatal("listing with no relay must be an error, not an empty list")
	}

	go s.KeepConnected(ctx, 100*time.Millisecond)
	startRelayAt(t, addr)

	deadline := time.Now().Add(10 * time.Second)
	for !s.IsConnected() {
		if time.Now().After(deadline) {
			t.Fatal("KeepConnected did not reconnect within 10s")
		}
		time.Sleep(50 * time.Millisecond)
	}
	files, err := s.ListFiles(context.Background(), strings.Repeat("a", 64))
	if err != nil || len(files) != 0 {
		t.Fatalf("after reconnect: %v, %v", files, err)
	}
}

// Lists tell "the relay has nothing" from "the relay did not answer".
func TestListsDistinguishNothingFromNoAnswer(t *testing.T) {
	pk := strings.Repeat("a", 64)
	ctx := func() context.Context {
		c, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		t.Cleanup(cancel)
		return c
	}
	none := connectedStore(t, fakeRelay(t, "none"))
	if f, err := none.ListFiles(ctx(), pk); err != nil || len(f) != 0 {
		t.Fatalf("none: ListFiles %v %v", f, err)
	}
	if f, err := none.ListFolders(ctx(), pk); err != nil || len(f) != 0 {
		t.Fatalf("none: ListFolders %v %v", f, err)
	}
	if _, err := none.GetFolder(ctx(), pk, "x"); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("none: GetFolder err = %v, want ErrFolderNotFound", err)
	}

	silent := connectedStore(t, fakeRelay(t, "silent"))
	for name, call := range map[string]func() error{
		"ListFiles":         func() error { _, err := silent.ListFiles(ctx(), pk); return err },
		"ListFilesInFolder": func() error { _, err := silent.ListFilesInFolder(ctx(), pk, ""); return err },
		"ListFolders":       func() error { _, err := silent.ListFolders(ctx(), pk); return err },
		"ListMyShares":      func() error { _, err := silent.ListMyShares(ctx(), pk); return err },
		"ListSharedWithMe":  func() error { _, err := silent.ListSharedWithMe(ctx(), pk); return err },
	} {
		if err := call(); !errors.Is(err, ErrRelayNoAnswer) {
			t.Errorf("silent: %s err = %v, want ErrRelayNoAnswer", name, err)
		}
	}
	if _, err := silent.GetFolder(ctx(), pk, "x"); err == nil || errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("silent: GetFolder err = %v, want an error that is not 'not found'", err)
	}
}

// startRelayAt serves an always-empty relay (EOSE, no events) on addr.
func startRelayAt(t *testing.T, addr string) {
	t.Helper()
	l, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen %s: %v", addr, err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		for {
			_, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var msg []json.RawMessage
			if json.Unmarshal(data, &msg) != nil || len(msg) < 2 {
				continue
			}
			var typ, sub string
			_ = json.Unmarshal(msg[0], &typ)
			_ = json.Unmarshal(msg[1], &sub)
			if typ == "REQ" {
				b, _ := json.Marshal([]any{"EOSE", sub})
				_ = c.Write(r.Context(), websocket.MessageText, b)
			}
		}
	}))
	_ = srv.Listener.Close()
	srv.Listener = l
	srv.Start()
	t.Cleanup(srv.Close)
}

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
