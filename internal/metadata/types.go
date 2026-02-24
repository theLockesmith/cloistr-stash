package metadata

import (
	"time"
)

// FileMetadata represents metadata for a file stored in Blossom
// Stored as Nostr kind 30078 parameterized replaceable event
type FileMetadata struct {
	// Identifier is the unique ID for this file (used as 'd' tag)
	// For encrypted files, this is the file_id used for key derivation
	Identifier string `json:"id"`

	// FileID is the unique identifier for key derivation (same as Identifier for encrypted files)
	FileID string `json:"file_id,omitempty"`

	// SHA256 hash of the file content (encrypted blob hash for encrypted files)
	SHA256 string `json:"sha256"`

	// PlaintextHash is the SHA256 of the original unencrypted content
	PlaintextHash string `json:"plaintext_hash,omitempty"`

	// Original filename
	Name string `json:"name,omitempty"`

	// File size in bytes (original size)
	Size int64 `json:"size"`

	// EncryptedSize is the size of the encrypted blob
	EncryptedSize int64 `json:"encrypted_size,omitempty"`

	// MIME type
	MimeType string `json:"mime_type,omitempty"`

	// Encrypted indicates if this file is encrypted
	Encrypted bool `json:"encrypted,omitempty"`

	// Encryption algorithm used (e.g., "xchacha20-poly1305")
	Encryption string `json:"encryption,omitempty"`

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

	// KindFileShare is the Nostr event kind for file share events
	// Content is NIP-04 encrypted share details for recipient
	KindFileShare = 30080
)

// FileShare represents a share of a file with another user
// Stored as Nostr kind 30080 parameterized replaceable event
type FileShare struct {
	// Identifier is the unique ID for this share (used as 'd' tag)
	Identifier string `json:"id"`

	// FileIdentifier is the 'd' tag of the shared file's Kind 30078 event
	FileIdentifier string `json:"file_id"`

	// FileSHA256 is the SHA256 hash of the shared file
	FileSHA256 string `json:"file_sha256"`

	// FileName is the original file name
	FileName string `json:"file_name,omitempty"`

	// FileSize is the file size in bytes
	FileSize int64 `json:"file_size,omitempty"`

	// FileMimeType is the MIME type of the file
	FileMimeType string `json:"file_mime_type,omitempty"`

	// FileURL is the Blossom URL for the file
	FileURL string `json:"file_url,omitempty"`

	// OwnerPubkey is the pubkey of the file owner (sharer)
	OwnerPubkey string `json:"owner_pubkey"`

	// RecipientPubkey is the pubkey of the share recipient
	RecipientPubkey string `json:"recipient_pubkey"`

	// Permission level: "read", "download"
	Permission string `json:"permission,omitempty"`

	// Message from the sharer
	Message string `json:"message,omitempty"`

	// ExpiresAt is when this share expires (zero value = never)
	ExpiresAt time.Time `json:"expires_at,omitempty"`

	// CreatedAt is when the share was created
	CreatedAt time.Time `json:"created_at"`
}
