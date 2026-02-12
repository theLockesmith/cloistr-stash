package metadata

import (
	"time"
)

// FileMetadata represents metadata for a file stored in Blossom
// Stored as Nostr kind 30078 parameterized replaceable event
type FileMetadata struct {
	// Identifier is the unique ID for this file (used as 'd' tag)
	// Typically the SHA256 hash of the file
	Identifier string `json:"id"`

	// SHA256 hash of the file content
	SHA256 string `json:"sha256"`

	// Original filename
	Name string `json:"name,omitempty"`

	// File size in bytes
	Size int64 `json:"size"`

	// MIME type
	MimeType string `json:"mime_type,omitempty"`

	// Blossom server URL where the file is stored
	URL string `json:"url,omitempty"`

	// Optional description
	Description string `json:"description,omitempty"`

	// Optional folder ID (for organization)
	FolderID string `json:"folder_id,omitempty"`

	// Owner's public key (hex)
	Pubkey string `json:"pubkey"`

	// Creation timestamp
	CreatedAt time.Time `json:"created_at"`

	// Last update timestamp
	UpdatedAt time.Time `json:"updated_at"`
}

// FolderMetadata represents a folder for organizing files
// Stored as Nostr kind 30079 parameterized replaceable event
type FolderMetadata struct {
	// Identifier is the unique ID for this folder (used as 'd' tag)
	Identifier string `json:"id"`

	// Folder name
	Name string `json:"name"`

	// Parent folder ID (empty for root)
	ParentID string `json:"parent_id,omitempty"`

	// Optional description
	Description string `json:"description,omitempty"`

	// Owner's public key (hex)
	Pubkey string `json:"pubkey"`

	// Creation timestamp
	CreatedAt time.Time `json:"created_at"`

	// Last update timestamp
	UpdatedAt time.Time `json:"updated_at"`
}

// Event kinds for Drive metadata
const (
	// KindFileMetadata is the Nostr event kind for file metadata
	// Using parameterized replaceable event (30000-39999 range)
	KindFileMetadata = 30078

	// KindFolderMetadata is the Nostr event kind for folder metadata
	KindFolderMetadata = 30079
)
