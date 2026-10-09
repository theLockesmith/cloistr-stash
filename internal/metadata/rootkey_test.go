package metadata

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeRelay answers every REQ according to mode:
//
//	"none":   EOSE with no events (the relay positively has nothing)
//	"key":    one root-key event, then EOSE
//	"silent": never answers (a slow or stuck relay)
//	"closed": CLOSED (e.g. auth-required)
func fakeRelay(t *testing.T, mode string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		ctx := r.Context()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			var msg []json.RawMessage
			if json.Unmarshal(data, &msg) != nil || len(msg) < 2 {
				continue
			}
			var typ, subID string
			_ = json.Unmarshal(msg[0], &typ)
			_ = json.Unmarshal(msg[1], &subID)
			if typ != "REQ" {
				continue
			}
			send := func(v any) {
				b, _ := json.Marshal(v)
				_ = c.Write(ctx, websocket.MessageText, b)
			}
			switch mode {
			case "none":
				send([]any{"EOSE", subID})
			case "key":
				send([]any{"EVENT", subID, map[string]any{
					"id":         strings.Repeat("1", 64),
					"pubkey":     strings.Repeat("a", 64),
					"created_at": 1700000000,
					"kind":       KindFileMetadata,
					"tags":       [][]string{{"d", "root-key"}, {"key", "ENCRYPTED-ROOT"}},
					"content":    "",
					"sig":        strings.Repeat("0", 128),
				}})
				send([]any{"EOSE", subID})
			case "closed":
				send([]any{"CLOSED", subID, "auth-required: sign in"})
			case "silent":
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func connectedStore(t *testing.T, url string) *Store {
	t.Helper()
	s := NewStore(url, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// End the connection by cancelling its context, not Store.Close: go-nostr
	// v0.52.3's Relay.close reads r.Connection while its write loop nils it,
	// which the race detector reports (a library race, not this package's).
	ctx, cancel := context.WithCancel(context.Background())
	if err := s.Connect(ctx); err != nil {
		cancel()
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(cancel)
	return s
}

// A root key lookup may only report "none" when the relay said so. Reporting
// "none" on a timeout makes the client generate and publish a new root key
// over the user's real one.
func TestGetRootKeyUnknownIsAnError(t *testing.T) {
	pk := strings.Repeat("a", 64)

	t.Run("relay answers none", func(t *testing.T) {
		got, err := connectedStore(t, fakeRelay(t, "none")).GetRootKey(context.Background(), pk)
		if err != nil || got != "" {
			t.Fatalf("got %q, %v; want \"\", nil", got, err)
		}
	})

	t.Run("relay returns the key", func(t *testing.T) {
		s := connectedStore(t, fakeRelay(t, "key"))
		s.relay.AssumeValid = true // the fake event is unsigned
		got, err := s.GetRootKey(context.Background(), pk)
		if err != nil || got != "ENCRYPTED-ROOT" {
			t.Fatalf("got %q, %v; want ENCRYPTED-ROOT, nil", got, err)
		}
	})

	for _, mode := range []string{"silent", "closed"} {
		t.Run("relay "+mode+" is an error, never none", func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
			defer cancel()
			got, err := connectedStore(t, fakeRelay(t, mode)).GetRootKey(ctx, pk)
			if err == nil {
				t.Fatalf("got %q with no error; an unanswered lookup must not read as \"no root key\"", got)
			}
			if !errors.Is(err, ErrRelayNoAnswer) {
				t.Fatalf("err = %v; want ErrRelayNoAnswer", err)
			}
		})
	}
}
