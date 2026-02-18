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

// CreateFolderEvent creates a Nostr event for folder metadata (unsigned)
func CreateFolderEvent(folder *FolderMetadata) *nostr.Event {
	content, _ := json.Marshal(map[string]interface{}{
		"name":        folder.Name,
		"description": folder.Description,
	})

	event := &nostr.Event{
		Kind:      KindFolderMetadata,
		PubKey:    folder.Pubkey,
		CreatedAt: nostr.Timestamp(folder.CreatedAt.Unix()),
		Tags: nostr.Tags{
			{"d", folder.Identifier}, // Parameterized replaceable event identifier
		},
		Content: string(content),
	}

	// Add parent folder tag if specified
	if folder.ParentID != "" {
		event.Tags = append(event.Tags, nostr.Tag{"parent", folder.ParentID})
	}

	return event
}

// ParseFolderEvent parses a Nostr event into FolderMetadata
func ParseFolderEvent(event *nostr.Event) (*FolderMetadata, error) {
	if event.Kind != KindFolderMetadata {
		return nil, fmt.Errorf("invalid event kind: %d", event.Kind)
	}

	folder := &FolderMetadata{
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
			folder.Identifier = tag[1]
		case "parent":
			folder.ParentID = tag[1]
		}
	}

	// Parse content for additional fields
	if event.Content != "" {
		var content map[string]interface{}
		if err := json.Unmarshal([]byte(event.Content), &content); err == nil {
			if name, ok := content["name"].(string); ok {
				folder.Name = name
			}
			if desc, ok := content["description"].(string); ok {
				folder.Description = desc
			}
		}
	}

	return folder, nil
}

// PublishFolder publishes folder metadata to the relay
// The event must be signed by the caller before passing to this function
func (s *Store) PublishFolder(ctx context.Context, event *nostr.Event) error {
	if s.relay == nil {
		return fmt.Errorf("not connected to relay")
	}

	if err := s.relay.Publish(ctx, *event); err != nil {
		return fmt.Errorf("failed to publish folder event: %w", err)
	}

	s.logger.Info("published folder metadata",
		"event_id", event.ID[:16],
		"pubkey", event.PubKey[:16],
	)

	return nil
}

// ListFolders queries the relay for all folders owned by a pubkey
func (s *Store) ListFolders(ctx context.Context, pubkey string) ([]*FolderMetadata, error) {
	if s.relay == nil {
		return nil, fmt.Errorf("not connected to relay")
	}

	filter := nostr.Filter{
		Kinds:   []int{KindFolderMetadata},
		Authors: []string{pubkey},
		Limit:   500,
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query folder events: %w", err)
	}

	// Parse events into folder metadata
	// Use map to deduplicate by identifier (parameterized replaceable events)
	folderMap := make(map[string]*FolderMetadata)
	for _, event := range events {
		folder, err := ParseFolderEvent(event)
		if err != nil {
			s.logger.Warn("failed to parse folder event",
				"event_id", event.ID[:16],
				"error", err,
			)
			continue
		}

		// Keep the most recent version (by created_at)
		existing, exists := folderMap[folder.Identifier]
		if !exists || folder.CreatedAt.After(existing.CreatedAt) {
			folderMap[folder.Identifier] = folder
		}
	}

	// Convert map to slice
	folders := make([]*FolderMetadata, 0, len(folderMap))
	for _, folder := range folderMap {
		folders = append(folders, folder)
	}

	s.logger.Info("listed folders",
		"pubkey", pubkey[:16],
		"count", len(folders),
	)

	return folders, nil
}

// GetFolder retrieves a specific folder's metadata
func (s *Store) GetFolder(ctx context.Context, pubkey, identifier string) (*FolderMetadata, error) {
	if s.relay == nil {
		return nil, fmt.Errorf("not connected to relay")
	}

	filter := nostr.Filter{
		Kinds:   []int{KindFolderMetadata},
		Authors: []string{pubkey},
		Tags:    map[string][]string{"d": {identifier}},
		Limit:   1,
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query folder event: %w", err)
	}

	if len(events) == 0 {
		return nil, fmt.Errorf("folder not found: %s", identifier)
	}

	return ParseFolderEvent(events[0])
}

// CreateDeleteFolderEvent creates a kind 5 deletion event for a folder
func CreateDeleteFolderEvent(pubkey, folderIdentifier string) *nostr.Event {
	return &nostr.Event{
		Kind:      5, // NIP-09 deletion event
		PubKey:    pubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Tags: nostr.Tags{
			{"a", fmt.Sprintf("%d:%s:%s", KindFolderMetadata, pubkey, folderIdentifier)},
		},
		Content: "deleted",
	}
}

// ListFilesInFolder queries files in a specific folder
func (s *Store) ListFilesInFolder(ctx context.Context, pubkey, folderID string) ([]*FileMetadata, error) {
	if s.relay == nil {
		return nil, fmt.Errorf("not connected to relay")
	}

	filter := nostr.Filter{
		Kinds:   []int{KindFileMetadata},
		Authors: []string{pubkey},
		Limit:   500,
	}

	// If folderID is specified, filter by folder tag
	if folderID != "" {
		filter.Tags = map[string][]string{"folder": {folderID}}
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query file events: %w", err)
	}

	// Parse and deduplicate
	fileMap := make(map[string]*FileMetadata)
	for _, event := range events {
		file, err := ParseFileEvent(event)
		if err != nil {
			continue
		}

		// For root folder (empty folderID), only include files without a folder
		if folderID == "" && file.FolderID != "" {
			continue
		}

		existing, exists := fileMap[file.Identifier]
		if !exists || file.CreatedAt.After(existing.CreatedAt) {
			fileMap[file.Identifier] = file
		}
	}

	files := make([]*FileMetadata, 0, len(fileMap))
	for _, file := range fileMap {
		files = append(files, file)
	}

	return files, nil
}

// CreateShareEvent creates a Nostr event for a file share (unsigned)
// The content should be NIP-04 encrypted by the caller before creating the event
func CreateShareEvent(share *FileShare, encryptedContent string) *nostr.Event {
	event := &nostr.Event{
		Kind:      KindFileShare,
		PubKey:    share.OwnerPubkey,
		CreatedAt: nostr.Timestamp(share.CreatedAt.Unix()),
		Tags: nostr.Tags{
			{"d", share.Identifier},
			{"p", share.RecipientPubkey},
			{"file", fmt.Sprintf("%d:%s:%s", KindFileMetadata, share.OwnerPubkey, share.FileIdentifier)},
		},
		Content: encryptedContent, // NIP-04 encrypted share details
	}

	// Add optional tags
	if share.Permission != "" {
		event.Tags = append(event.Tags, nostr.Tag{"permission", share.Permission})
	}

	if !share.ExpiresAt.IsZero() {
		event.Tags = append(event.Tags, nostr.Tag{"expiration", fmt.Sprintf("%d", share.ExpiresAt.Unix())})
	}

	return event
}

// ParseShareEvent parses a Nostr event into FileShare
// Note: The content is NIP-04 encrypted and must be decrypted by the caller
func ParseShareEvent(event *nostr.Event) (*FileShare, error) {
	if event.Kind != KindFileShare {
		return nil, fmt.Errorf("invalid event kind: %d", event.Kind)
	}

	share := &FileShare{
		OwnerPubkey: event.PubKey,
		CreatedAt:   time.Unix(int64(event.CreatedAt), 0),
	}

	// Parse tags
	for _, tag := range event.Tags {
		if len(tag) < 2 {
			continue
		}
		switch tag[0] {
		case "d":
			share.Identifier = tag[1]
		case "p":
			share.RecipientPubkey = tag[1]
		case "file":
			// Parse file reference: "30078:pubkey:file-id"
			share.FileIdentifier = tag[1]
		case "permission":
			share.Permission = tag[1]
		case "expiration":
			var expiry int64
			fmt.Sscanf(tag[1], "%d", &expiry)
			if expiry > 0 {
				share.ExpiresAt = time.Unix(expiry, 0)
			}
		}
	}

	// Content is encrypted - caller must decrypt
	// We store it temporarily in Message field for transport
	share.Message = event.Content

	return share, nil
}

// PublishShare publishes a file share event to the relay
// The event must be signed by the caller before passing to this function
func (s *Store) PublishShare(ctx context.Context, event *nostr.Event) error {
	if s.relay == nil {
		return fmt.Errorf("not connected to relay")
	}

	if err := s.relay.Publish(ctx, *event); err != nil {
		return fmt.Errorf("failed to publish share event: %w", err)
	}

	s.logger.Info("published file share",
		"event_id", event.ID[:16],
		"owner", event.PubKey[:16],
	)

	return nil
}

// ListSharedWithMe queries shares where the given pubkey is the recipient
func (s *Store) ListSharedWithMe(ctx context.Context, recipientPubkey string) ([]*FileShare, error) {
	if s.relay == nil {
		return nil, fmt.Errorf("not connected to relay")
	}

	filter := nostr.Filter{
		Kinds: []int{KindFileShare},
		Tags:  map[string][]string{"p": {recipientPubkey}},
		Limit: 500,
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query share events: %w", err)
	}

	// Parse and deduplicate by identifier
	shareMap := make(map[string]*FileShare)
	now := time.Now()

	for _, event := range events {
		share, err := ParseShareEvent(event)
		if err != nil {
			s.logger.Warn("failed to parse share event",
				"event_id", event.ID[:16],
				"error", err,
			)
			continue
		}

		// Skip expired shares
		if !share.ExpiresAt.IsZero() && share.ExpiresAt.Before(now) {
			continue
		}

		// Keep the most recent version
		existing, exists := shareMap[share.Identifier]
		if !exists || share.CreatedAt.After(existing.CreatedAt) {
			shareMap[share.Identifier] = share
		}
	}

	shares := make([]*FileShare, 0, len(shareMap))
	for _, share := range shareMap {
		shares = append(shares, share)
	}

	s.logger.Info("listed shares with recipient",
		"recipient", recipientPubkey[:16],
		"count", len(shares),
	)

	return shares, nil
}

// ListMyShares queries shares created by the given pubkey
func (s *Store) ListMyShares(ctx context.Context, ownerPubkey string) ([]*FileShare, error) {
	if s.relay == nil {
		return nil, fmt.Errorf("not connected to relay")
	}

	filter := nostr.Filter{
		Kinds:   []int{KindFileShare},
		Authors: []string{ownerPubkey},
		Limit:   500,
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query share events: %w", err)
	}

	// Parse and deduplicate
	shareMap := make(map[string]*FileShare)
	for _, event := range events {
		share, err := ParseShareEvent(event)
		if err != nil {
			continue
		}

		existing, exists := shareMap[share.Identifier]
		if !exists || share.CreatedAt.After(existing.CreatedAt) {
			shareMap[share.Identifier] = share
		}
	}

	shares := make([]*FileShare, 0, len(shareMap))
	for _, share := range shareMap {
		shares = append(shares, share)
	}

	s.logger.Info("listed shares by owner",
		"owner", ownerPubkey[:16],
		"count", len(shares),
	)

	return shares, nil
}

// CreateDeleteShareEvent creates a kind 5 deletion event for a share
func CreateDeleteShareEvent(pubkey, shareIdentifier string) *nostr.Event {
	return &nostr.Event{
		Kind:      5, // NIP-09 deletion event
		PubKey:    pubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Tags: nostr.Tags{
			{"a", fmt.Sprintf("%d:%s:%s", KindFileShare, pubkey, shareIdentifier)},
		},
		Content: "revoked",
	}
}
