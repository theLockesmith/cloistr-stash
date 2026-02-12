package metadata

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// Store handles file metadata storage via Nostr relay
type Store struct {
	relayURL string
	relay    *nostr.Relay
	logger   *slog.Logger
	mu       sync.RWMutex

	// Local cache of file metadata by pubkey
	cache map[string][]*FileMetadata
}

// NewStore creates a new metadata store
func NewStore(relayURL string, logger *slog.Logger) *Store {
	return &Store{
		relayURL: relayURL,
		logger:   logger,
		cache:    make(map[string][]*FileMetadata),
	}
}

// Connect establishes connection to the relay
func (s *Store) Connect(ctx context.Context) error {
	relay, err := nostr.RelayConnect(ctx, s.relayURL)
	if err != nil {
		return fmt.Errorf("failed to connect to relay: %w", err)
	}
	s.relay = relay
	s.logger.Info("connected to relay", "url", s.relayURL)
	return nil
}

// Close closes the relay connection
func (s *Store) Close() {
	if s.relay != nil {
		s.relay.Close()
	}
}

// PublishFile publishes file metadata to the relay
// The event must be signed by the caller before passing to this function
func (s *Store) PublishFile(ctx context.Context, event *nostr.Event) error {
	if s.relay == nil {
		return fmt.Errorf("not connected to relay")
	}

	if err := s.relay.Publish(ctx, *event); err != nil {
		return fmt.Errorf("failed to publish event: %w", err)
	}

	s.logger.Info("published file metadata",
		"event_id", event.ID[:16],
		"pubkey", event.PubKey[:16],
	)

	return nil
}

// CreateFileEvent creates a Nostr event for file metadata (unsigned)
func CreateFileEvent(file *FileMetadata) *nostr.Event {
	// Create content as JSON
	content, _ := json.Marshal(map[string]interface{}{
		"name":        file.Name,
		"size":        file.Size,
		"mime_type":   file.MimeType,
		"description": file.Description,
	})

	event := &nostr.Event{
		Kind:      KindFileMetadata,
		PubKey:    file.Pubkey,
		CreatedAt: nostr.Timestamp(file.CreatedAt.Unix()),
		Tags: nostr.Tags{
			{"d", file.Identifier},           // Parameterized replaceable event identifier
			{"x", file.SHA256},               // File hash
			{"url", file.URL},                // Blossom URL
			{"m", file.MimeType},             // MIME type
			{"size", fmt.Sprintf("%d", file.Size)}, // File size
		},
		Content: string(content),
	}

	// Add folder tag if specified
	if file.FolderID != "" {
		event.Tags = append(event.Tags, nostr.Tag{"folder", file.FolderID})
	}

	return event
}

// ParseFileEvent parses a Nostr event into FileMetadata
func ParseFileEvent(event *nostr.Event) (*FileMetadata, error) {
	if event.Kind != KindFileMetadata {
		return nil, fmt.Errorf("invalid event kind: %d", event.Kind)
	}

	file := &FileMetadata{
		Pubkey:    event.PubKey,
		CreatedAt: time.Unix(int64(event.CreatedAt), 0),
		UpdatedAt: time.Unix(int64(event.CreatedAt), 0),
	}

	// Parse tags
	for _, tag := range event.Tags {
		if len(tag) < 2 {
			continue
		}
		switch tag[0] {
		case "d":
			file.Identifier = tag[1]
		case "x":
			file.SHA256 = tag[1]
		case "url":
			file.URL = tag[1]
		case "m":
			file.MimeType = tag[1]
		case "size":
			fmt.Sscanf(tag[1], "%d", &file.Size)
		case "folder":
			file.FolderID = tag[1]
		}
	}

	// Parse content for additional fields
	if event.Content != "" {
		var content map[string]interface{}
		if err := json.Unmarshal([]byte(event.Content), &content); err == nil {
			if name, ok := content["name"].(string); ok {
				file.Name = name
			}
			if desc, ok := content["description"].(string); ok {
				file.Description = desc
			}
		}
	}

	return file, nil
}

// ListFiles queries the relay for all files owned by a pubkey
func (s *Store) ListFiles(ctx context.Context, pubkey string) ([]*FileMetadata, error) {
	if s.relay == nil {
		return nil, fmt.Errorf("not connected to relay")
	}

	// Create subscription filter
	filter := nostr.Filter{
		Kinds:   []int{KindFileMetadata},
		Authors: []string{pubkey},
		Limit:   500,
	}

	// Query events
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query events: %w", err)
	}

	// Parse events into file metadata
	// Use map to deduplicate by identifier (parameterized replaceable events)
	fileMap := make(map[string]*FileMetadata)
	for _, event := range events {
		file, err := ParseFileEvent(event)
		if err != nil {
			s.logger.Warn("failed to parse file event",
				"event_id", event.ID[:16],
				"error", err,
			)
			continue
		}

		// Keep the most recent version (by created_at)
		existing, exists := fileMap[file.Identifier]
		if !exists || file.CreatedAt.After(existing.CreatedAt) {
			fileMap[file.Identifier] = file
		}
	}

	// Convert map to slice
	files := make([]*FileMetadata, 0, len(fileMap))
	for _, file := range fileMap {
		files = append(files, file)
	}

	s.logger.Info("listed files",
		"pubkey", pubkey[:16],
		"count", len(files),
	)

	// Update cache
	s.mu.Lock()
	s.cache[pubkey] = files
	s.mu.Unlock()

	return files, nil
}

// GetFile retrieves a specific file's metadata
func (s *Store) GetFile(ctx context.Context, pubkey, identifier string) (*FileMetadata, error) {
	if s.relay == nil {
		return nil, fmt.Errorf("not connected to relay")
	}

	// Create filter for specific file
	filter := nostr.Filter{
		Kinds:   []int{KindFileMetadata},
		Authors: []string{pubkey},
		Tags:    map[string][]string{"d": {identifier}},
		Limit:   1,
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query event: %w", err)
	}

	if len(events) == 0 {
		return nil, fmt.Errorf("file not found: %s", identifier)
	}

	return ParseFileEvent(events[0])
}

// DeleteFile publishes a deletion event for a file
// In Nostr, we publish a kind 5 deletion event referencing the file event
func (s *Store) DeleteFile(ctx context.Context, event *nostr.Event) error {
	if s.relay == nil {
		return fmt.Errorf("not connected to relay")
	}

	if err := s.relay.Publish(ctx, *event); err != nil {
		return fmt.Errorf("failed to publish deletion event: %w", err)
	}

	return nil
}

// CreateDeleteEvent creates a kind 5 deletion event for a file
func CreateDeleteEvent(pubkey, fileIdentifier string) *nostr.Event {
	return &nostr.Event{
		Kind:      5, // NIP-09 deletion event
		PubKey:    pubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Tags: nostr.Tags{
			{"a", fmt.Sprintf("%d:%s:%s", KindFileMetadata, pubkey, fileIdentifier)},
		},
		Content: "deleted",
	}
}
