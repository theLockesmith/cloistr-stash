package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/metadata"
	"github.com/coder/websocket"
)

// relayStub is a minimal relay: "none" answers every REQ with EOSE and no
// events; "silent" never answers. While down is set it refuses connections.
type relayStub struct {
	URL  string
	down atomic.Bool
}

func newRelayStub(t *testing.T, mode string) *relayStub {
	t.Helper()
	rs := &relayStub{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rs.down.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
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
			if typ == "REQ" && mode == "none" {
				b, _ := json.Marshal([]any{"EOSE", sub})
				_ = c.Write(r.Context(), websocket.MessageText, b)
			}
		}
	}))
	t.Cleanup(srv.Close)
	rs.URL = "ws" + strings.TrimPrefix(srv.URL, "http")
	return rs
}

// storeFor returns a store for url; connect=false leaves it unconnected.
// (Never Close it: see metadata/rootkey_test.go on the go-nostr close race.)
func storeFor(t *testing.T, url string, connect bool) *metadata.Store {
	t.Helper()
	st := metadata.NewStore(url, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if connect {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		if err := st.Connect(ctx); err != nil {
			t.Fatalf("connect: %v", err)
		}
	}
	return st
}
