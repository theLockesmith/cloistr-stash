package storage

import (
	"context"
	"io"
)

// FileInfo contains metadata about a stored file
type FileInfo struct {
	SHA256   string
	Size     int64
	MimeType string
}

// Backend defines the interface for storage implementations
type Backend interface {
	// Store saves a file and returns its SHA256 hash
	Store(ctx context.Context, data io.Reader) (sha256 string, size int64, err error)

	// Retrieve fetches a file by its SHA256 hash
	Retrieve(ctx context.Context, sha256 string) (io.ReadCloser, *FileInfo, error)

	// Delete removes a file by its SHA256 hash
	Delete(ctx context.Context, sha256 string) error

	// Exists checks if a file with the given SHA256 hash exists
	Exists(ctx context.Context, sha256 string) (bool, error)

	// List returns all SHA256 hashes for a given public key
	List(ctx context.Context, pubkey string) ([]FileInfo, error)

	// GetSize returns the size of a file by its SHA256 hash
	GetSize(ctx context.Context, sha256 string) (int64, error)
}
