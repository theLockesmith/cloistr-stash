package metadata

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"git.coldforge.xyz/coldforge/cloistr-common/relayprefs"
	"github.com/nbd-wtf/go-nostr"
)

// Connection health constants
const (
	maxConsecutiveFailures = 10              // Mark unhealthy after this many failures
	failureResetDuration   = 2 * time.Minute // Reset failure count after successful connection for this long
)

// truncateForLog safely truncates a string for logging, avoiding panics on short strings
func truncateForLog(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

// Store handles file metadata storage via Nostr relay
type Store struct {
	relayURL string
	relay    *nostr.Relay
	logger   *slog.Logger
	mu       sync.RWMutex

	// Relay preferences client for user-preferred relay publishing
	relayPrefs *relayprefs.Client

	// Local cache of file metadata by pubkey
	cache map[string][]*FileMetadata

	// Connection management
	connMu      sync.Mutex
	baseCtx     context.Context
	cancelFunc  context.CancelFunc

	// Connection health tracking
	consecutiveFailures int
	lastSuccessTime     time.Time
	unhealthy           bool
}

// NewStore creates a new metadata store
func NewStore(relayURL string, logger *slog.Logger) *Store {
	return &Store{
		relayURL: relayURL,
		logger:   logger,
		cache:    make(map[string][]*FileMetadata),
	}
}

// NewStoreWithRelayPrefs creates a new metadata store with relay preferences support
func NewStoreWithRelayPrefs(relayURL string, logger *slog.Logger, relayPrefsClient *relayprefs.Client) *Store {
	return &Store{
		relayURL:   relayURL,
		logger:     logger,
		cache:      make(map[string][]*FileMetadata),
		relayPrefs: relayPrefsClient,
	}
}

// Connect establishes connection to the relay
func (s *Store) Connect(ctx context.Context) error {
	s.connMu.Lock()
	defer s.connMu.Unlock()

	// Store base context for reconnection
	s.baseCtx, s.cancelFunc = context.WithCancel(ctx)

	return s.connectLocked()
}

// connectLocked performs the actual connection (must hold connMu)
func (s *Store) connectLocked() error {
	// Use a timeout to prevent indefinite hangs on connection failures
	ctx, cancel := context.WithTimeout(s.baseCtx, 15*time.Second)
	defer cancel()

	relay, err := nostr.RelayConnect(ctx, s.relayURL)
	if err != nil {
		return fmt.Errorf("failed to connect to relay: %w", err)
	}
	s.relay = relay
	s.logger.Info("connected to relay", "url", s.relayURL)
	return nil
}

// ensureConnected checks connection and reconnects if needed
func (s *Store) ensureConnected() error {
	s.connMu.Lock()
	defer s.connMu.Unlock()

	// Check if we have a connection and it's still alive
	if s.relay != nil && s.relay.IsConnected() {
		// Reset failure tracking on sustained healthy connection
		if time.Since(s.lastSuccessTime) < failureResetDuration {
			s.consecutiveFailures = 0
			s.unhealthy = false
		}
		s.lastSuccessTime = time.Now()
		return nil
	}

	// Need to reconnect
	if s.relay != nil {
		s.logger.Warn("relay connection lost, reconnecting", "url", s.relayURL)
	}

	// Close old connection if any
	if s.relay != nil {
		_ = s.relay.Close()
		s.relay = nil
	}

	// Reconnect
	if err := s.connectLocked(); err != nil {
		s.consecutiveFailures++
		if s.consecutiveFailures >= maxConsecutiveFailures {
			s.unhealthy = true
			s.logger.Error("relay connection unhealthy, marking for restart",
				"consecutive_failures", s.consecutiveFailures,
				"url", s.relayURL)
		}
		return fmt.Errorf("failed to reconnect to relay: %w", err)
	}

	// Success - reset failure count
	s.consecutiveFailures = 0
	s.lastSuccessTime = time.Now()
	s.logger.Info("reconnected to relay", "url", s.relayURL)
	return nil
}

// IsHealthy returns false if the store has exceeded max consecutive connection failures
func (s *Store) IsHealthy() bool {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	return !s.unhealthy
}

// Close closes the relay connection
func (s *Store) Close() {
	s.connMu.Lock()
	defer s.connMu.Unlock()

	if s.cancelFunc != nil {
		s.cancelFunc()
	}
	if s.relay != nil {
		_ = s.relay.Close()
		s.relay = nil
	}
}

// PublishFile publishes file metadata to the relay
// The event must be signed by the caller before passing to this function
func (s *Store) PublishFile(ctx context.Context, event *nostr.Event) error {
	if err := s.ensureConnected(); err != nil {
		return err
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

// PublishToUserRelays publishes an event to the user's preferred write relays.
// Falls back to the configured default relay if relay preferences are not available.
// The event must be signed before calling this method.
func (s *Store) PublishToUserRelays(ctx context.Context, event *nostr.Event) error {
	pubkey := event.PubKey

	// Get user's preferred relays
	var writeRelays []string
	if s.relayPrefs != nil {
		prefs, err := s.relayPrefs.GetRelayPrefs(ctx, pubkey)
		if err != nil {
			s.logger.Warn("failed to get relay prefs, using default",
				"pubkey", truncateForLog(pubkey, 16),
				"error", err,
			)
		} else if prefs != nil && len(prefs.WriteRelays()) > 0 {
			writeRelays = prefs.WriteRelays()
			s.logger.Debug("using user relay preferences",
				"pubkey", truncateForLog(pubkey, 16),
				"relays", len(writeRelays),
				"source", prefs.Source,
			)
		}
	}

	// Fall back to default relay if no preferences
	if len(writeRelays) == 0 {
		writeRelays = []string{s.relayURL}
	}

	// Publish to all write relays
	var lastErr error
	successCount := 0

	for _, relayURL := range writeRelays {
		relay, err := nostr.RelayConnect(ctx, relayURL)
		if err != nil {
			s.logger.Warn("failed to connect to relay",
				"relay", relayURL,
				"error", err,
			)
			lastErr = err
			continue
		}

		if err := relay.Publish(ctx, *event); err != nil {
			s.logger.Warn("failed to publish to relay",
				"relay", relayURL,
				"event_id", event.ID[:16],
				"error", err,
			)
			lastErr = err
			_ = relay.Close()
			continue
		}

		_ = relay.Close()
		successCount++
	}

	if successCount == 0 {
		return fmt.Errorf("failed to publish to any relay: %w", lastErr)
	}

	s.logger.Info("published to user relays",
		"event_id", event.ID[:16],
		"pubkey", truncateForLog(pubkey, 16),
		"success", successCount,
		"total", len(writeRelays),
	)

	return nil
}

// InvalidateRelayPrefsCache invalidates the relay preferences cache for a user.
// Call this when a user updates their relay preferences.
func (s *Store) InvalidateRelayPrefsCache(pubkey string) {
	if s.relayPrefs != nil {
		s.relayPrefs.InvalidateCache(pubkey)
	}
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
			file.FileID = tag[1] // Same as identifier for encrypted files
		case "x":
			file.SHA256 = tag[1]
		case "ox":
			file.PlaintextHash = tag[1]
		case "url":
			file.URL = tag[1]
		case "m":
			file.MimeType = tag[1]
		case "size":
			_, _ = fmt.Sscanf(tag[1], "%d", &file.Size)
		case "folder":
			file.FolderID = tag[1]
		case "encrypted":
			file.Encrypted = true
			file.Encryption = tag[1]
		case "deleted_at":
			var deletedAt int64
			_, _ = fmt.Sscanf(tag[1], "%d", &deletedAt)
			file.DeletedAt = deletedAt
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
			if encrypted, ok := content["encrypted"].(bool); ok {
				file.Encrypted = encrypted
			}
			if encSize, ok := content["encrypted_size"].(float64); ok {
				file.EncryptedSize = int64(encSize)
			}
			// Parse deleted_at from content (in addition to tag)
			if deletedAt, ok := content["deleted_at"].(float64); ok && file.DeletedAt == 0 {
				file.DeletedAt = int64(deletedAt)
			}
		}
	}

	return file, nil
}

// ListFiles queries the relay for all files owned by a pubkey
func (s *Store) ListFiles(ctx context.Context, pubkey string) ([]*FileMetadata, error) {
	if err := s.ensureConnected(); err != nil {
		return nil, err
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

		// Skip config events that use the same kind (root-key, etc.)
		if file.Identifier == "root-key" {
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
		"pubkey", truncateForLog(pubkey, 16),
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
	if err := s.ensureConnected(); err != nil {
		return nil, err
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

// GetFileBySHA256 retrieves file metadata by its SHA256 hash
// This is used for public links where we don't know the owner
func (s *Store) GetFileBySHA256(ctx context.Context, sha256 string) (*FileMetadata, error) {
	if err := s.ensureConnected(); err != nil {
		return nil, err
	}

	// Create filter for file by SHA256 hash (x tag)
	filter := nostr.Filter{
		Kinds: []int{KindFileMetadata},
		Tags:  map[string][]string{"x": {sha256}},
		Limit: 1,
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query event: %w", err)
	}

	if len(events) == 0 {
		return nil, fmt.Errorf("file not found: %s", sha256)
	}

	return ParseFileEvent(events[0])
}

// DeleteFile publishes a deletion event for a file
// In Nostr, we publish a kind 5 deletion event referencing the file event
func (s *Store) DeleteFile(ctx context.Context, event *nostr.Event) error {
	if err := s.ensureConnected(); err != nil {
		return err
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
		case "key":
			folder.EncryptedKey = tag[1]
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
	if err := s.ensureConnected(); err != nil {
		return err
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
	if err := s.ensureConnected(); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Query folder events
	folderFilter := nostr.Filter{
		Kinds:   []int{KindFolderMetadata},
		Authors: []string{pubkey},
		Limit:   500,
	}

	events, err := s.relay.QuerySync(ctx, folderFilter)
	if err != nil {
		return nil, fmt.Errorf("failed to query folder events: %w", err)
	}

	// Query deletion events (kind:5) that reference folders
	// NIP-09: deletion events have 'a' tags like "30079:pubkey:folderId"
	deletionFilter := nostr.Filter{
		Kinds:   []int{5},
		Authors: []string{pubkey},
		Limit:   500,
	}

	deletionEvents, err := s.relay.QuerySync(ctx, deletionFilter)
	if err != nil {
		s.logger.Warn("failed to query deletion events, proceeding without filtering",
			"error", err,
		)
		deletionEvents = nil
	}

	// Build set of deleted folder IDs from kind:5 events
	deletedFolders := make(map[string]bool)
	for _, event := range deletionEvents {
		for _, tag := range event.Tags {
			if len(tag) >= 2 && tag[0] == "a" {
				// Parse "a" tag: "30079:pubkey:folderId"
				parts := strings.SplitN(tag[1], ":", 3)
				if len(parts) == 3 && parts[0] == "30079" {
					deletedFolders[parts[2]] = true
				}
			}
		}
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

		// Skip deleted folders
		if deletedFolders[folder.Identifier] {
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
		"pubkey", truncateForLog(pubkey, 16),
		"count", len(folders),
		"deleted_count", len(deletedFolders),
	)

	return folders, nil
}

// GetFolder retrieves a specific folder's metadata
func (s *Store) GetFolder(ctx context.Context, pubkey, identifier string) (*FolderMetadata, error) {
	if err := s.ensureConnected(); err != nil {
		return nil, err
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
	if err := s.ensureConnected(); err != nil {
		return nil, err
	}

	// Fetch all files for this user (don't rely on relay's tag filtering)
	// This is more reliable since some relays don't properly support custom tag filters
	filter := nostr.Filter{
		Kinds:   []int{KindFileMetadata},
		Authors: []string{pubkey},
		Limit:   500,
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("failed to query file events: %w", err)
	}

	// Parse and deduplicate by identifier (newer event wins)
	fileMap := make(map[string]*FileMetadata)
	var parseErrors, configSkipped int
	for _, event := range events {
		file, err := ParseFileEvent(event)
		if err != nil {
			parseErrors++
			s.logger.Debug("failed to parse file event in folder listing",
				"event_id", event.ID[:16],
				"error", err,
			)
			continue
		}

		// Skip config events that use the same kind (root-key, etc.)
		if file.Identifier == "root-key" {
			configSkipped++
			continue
		}

		existing, exists := fileMap[file.Identifier]
		if !exists || file.CreatedAt.After(existing.CreatedAt) {
			fileMap[file.Identifier] = file
		}
	}

	// Filter by folder server-side
	files := make([]*FileMetadata, 0, len(fileMap))
	for _, file := range fileMap {
		// Root folder: include files without a folder
		// Specific folder: include files with matching folder
		if folderID == "" && file.FolderID == "" {
			files = append(files, file)
		} else if folderID != "" && file.FolderID == folderID {
			files = append(files, file)
		}
	}

	folderDesc := folderID
	if folderID == "" {
		folderDesc = "(root)"
	}
	s.logger.Info("listed files in folder",
		"pubkey", truncateForLog(pubkey, 16),
		"folder", folderDesc,
		"events_received", len(events),
		"unique_files", len(fileMap),
		"files_in_folder", len(files),
		"parse_errors", parseErrors,
		"config_skipped", configSkipped,
	)

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
			_, _ = fmt.Sscanf(tag[1], "%d", &expiry)
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
	if err := s.ensureConnected(); err != nil {
		return err
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
	if err := s.ensureConnected(); err != nil {
		return nil, err
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
	if err := s.ensureConnected(); err != nil {
		return nil, err
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

// CalculateStorageUsage calculates total storage used by a user
// This queries the relay for all file metadata and sums the sizes
// Returns the total bytes stored (encrypted size for encrypted files, original size otherwise)
func (s *Store) CalculateStorageUsage(ctx context.Context, pubkey string) (int64, error) {
	files, err := s.ListFiles(ctx, pubkey)
	if err != nil {
		return 0, fmt.Errorf("failed to list files: %w", err)
	}

	var totalSize int64
	for _, file := range files {
		// Use encrypted size if available, otherwise original size
		if file.EncryptedSize > 0 {
			totalSize += file.EncryptedSize
		} else {
			totalSize += file.Size
		}
	}

	s.logger.Debug("calculated storage usage",
		"pubkey", pubkey[:min(16, len(pubkey))],
		"files", len(files),
		"total_bytes", totalSize,
	)

	return totalSize, nil
}

// GetRootKey retrieves the encrypted root key event for a user
// The root key is stored as a kind 30078 event with d='root-key'
func (s *Store) GetRootKey(ctx context.Context, pubkey string) (string, error) {
	if err := s.ensureConnected(); err != nil {
		return "", err
	}

	filter := nostr.Filter{
		Kinds:   []int{KindFileMetadata},
		Authors: []string{pubkey},
		Tags:    map[string][]string{"d": {"root-key"}},
		Limit:   1,
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	events, err := s.relay.QuerySync(ctx, filter)
	if err != nil {
		return "", fmt.Errorf("failed to query root key event: %w", err)
	}

	if len(events) == 0 {
		return "", nil // No root key stored yet
	}

	// Get the most recent event
	var latest *nostr.Event
	for _, event := range events {
		if latest == nil || event.CreatedAt > latest.CreatedAt {
			latest = event
		}
	}

	// Extract the encrypted key from the 'key' tag
	for _, tag := range latest.Tags {
		if len(tag) >= 2 && tag[0] == "key" {
			s.logger.Debug("found root key event",
				"pubkey", truncateForLog(pubkey, 16),
				"event_id", latest.ID[:16],
			)
			return tag[1], nil
		}
	}

	return "", nil // No key tag found
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
