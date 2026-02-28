package storage

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Filesystem implements the Backend interface using the local filesystem
type Filesystem struct {
	basePath string
	mu       sync.RWMutex
}

// NewFilesystem creates a new filesystem storage backend
func NewFilesystem(basePath string) (*Filesystem, error) {
	// Create the base directory if it doesn't exist
	if err := os.MkdirAll(basePath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create storage directory: %w", err)
	}

	return &Filesystem{
		basePath: basePath,
	}, nil
}

// Store saves a file and returns its SHA256 hash
func (fs *Filesystem) Store(ctx context.Context, data io.Reader) (hash string, size int64, err error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	// Calculate SHA256 while reading
	hasher := sha256.New()
	teeReader := io.TeeReader(data, hasher)

	// Write to temporary file first
	tempPath := filepath.Join(fs.basePath, ".tmp")
	tempFile, err := os.CreateTemp(tempPath, "upload-*")
	if err != nil {
		if os.IsNotExist(err) {
			// Create temp directory
			if err := os.MkdirAll(tempPath, 0755); err != nil {
				return "", 0, fmt.Errorf("failed to create temp directory: %w", err)
			}
			tempFile, err = os.CreateTemp(tempPath, "upload-*")
			if err != nil {
				return "", 0, fmt.Errorf("failed to create temp file: %w", err)
			}
		} else {
			return "", 0, fmt.Errorf("failed to create temp file: %w", err)
		}
	}
	defer func() { _ = tempFile.Close() }()

	// Copy data to temp file
	size, err = io.Copy(tempFile, teeReader)
	if err != nil {
		_ = os.Remove(tempFile.Name())
		return "", 0, fmt.Errorf("failed to write data: %w", err)
	}

	// Get the SHA256 hash
	hash = fmt.Sprintf("%x", hasher.Sum(nil))

	// Create directory structure: basePath/xx/yyzzzz...
	hashDir := filepath.Join(fs.basePath, hash[:2])
	if err := os.MkdirAll(hashDir, 0755); err != nil {
		_ = os.Remove(tempFile.Name())
		return "", 0, fmt.Errorf("failed to create hash directory: %w", err)
	}

	// Move temp file to final location
	finalPath := filepath.Join(hashDir, hash[2:])

	// If file already exists, just remove temp file
	if _, err := os.Stat(finalPath); err == nil {
		_ = os.Remove(tempFile.Name())
		return hash, size, nil
	}

	if err := os.Rename(tempFile.Name(), finalPath); err != nil {
		_ = os.Remove(tempFile.Name())
		return "", 0, fmt.Errorf("failed to move file to final location: %w", err)
	}

	return hash, size, nil
}

// Retrieve fetches a file by its SHA256 hash
func (fs *Filesystem) Retrieve(ctx context.Context, sha256 string) (io.ReadCloser, *FileInfo, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	filePath := filepath.Join(fs.basePath, sha256[:2], sha256[2:])

	file, err := os.Open(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, fmt.Errorf("file not found")
		}
		return nil, nil, fmt.Errorf("failed to open file: %w", err)
	}

	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, fmt.Errorf("failed to stat file: %w", err)
	}

	fileInfo := &FileInfo{
		SHA256: sha256,
		Size:   info.Size(),
	}

	return file, fileInfo, nil
}

// Delete removes a file by its SHA256 hash
func (fs *Filesystem) Delete(ctx context.Context, sha256 string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	filePath := filepath.Join(fs.basePath, sha256[:2], sha256[2:])

	if err := os.Remove(filePath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("file not found")
		}
		return fmt.Errorf("failed to delete file: %w", err)
	}

	return nil
}

// Exists checks if a file with the given SHA256 hash exists
func (fs *Filesystem) Exists(ctx context.Context, sha256 string) (bool, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	filePath := filepath.Join(fs.basePath, sha256[:2], sha256[2:])
	_, err := os.Stat(filePath)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, fmt.Errorf("failed to check file: %w", err)
}

// List returns all SHA256 hashes for a given public key
// Note: This is a stub implementation - actual implementation would track uploads by pubkey
func (fs *Filesystem) List(ctx context.Context, pubkey string) ([]FileInfo, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	var files []FileInfo

	// Walk the storage directory and collect all files
	err := filepath.Walk(fs.basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip directories and temp files
		if info.IsDir() || info.Name() == ".tmp" {
			return nil
		}

		// Get the relative path components to reconstruct hash
		rel, err := filepath.Rel(fs.basePath, path)
		if err != nil {
			return nil
		}

		// Skip files not in the hash structure
		parts := filepath.SplitList(rel)
		if len(parts) != 2 {
			return nil
		}

		hash := parts[0] + parts[1]
		files = append(files, FileInfo{
			SHA256: hash,
			Size:   info.Size(),
		})

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to list files: %w", err)
	}

	return files, nil
}

// GetSize returns the size of a file by its SHA256 hash
func (fs *Filesystem) GetSize(ctx context.Context, sha256 string) (int64, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	filePath := filepath.Join(fs.basePath, sha256[:2], sha256[2:])
	info, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, fmt.Errorf("file not found")
		}
		return 0, fmt.Errorf("failed to stat file: %w", err)
	}

	return info.Size(), nil
}
