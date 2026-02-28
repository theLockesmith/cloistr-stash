package storage

import (
	"bytes"
	"context"
	"io"
	"testing"
)

func TestFilesystemStore(t *testing.T) {
	// Create temporary directory for testing
	tmpDir := t.TempDir()

	fs, err := NewFilesystem(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem storage: %v", err)
	}

	// Create test data
	testData := []byte("test file content")
	reader := bytes.NewReader(testData)

	// Store file
	sha256, size, err := fs.Store(context.Background(), reader)
	if err != nil {
		t.Fatalf("Failed to store file: %v", err)
	}

	if size != int64(len(testData)) {
		t.Errorf("Expected size %d, got %d", len(testData), size)
	}

	if sha256 == "" {
		t.Error("Expected non-empty SHA256")
	}

	// Verify file exists
	exists, err := fs.Exists(context.Background(), sha256)
	if err != nil {
		t.Fatalf("Failed to check existence: %v", err)
	}

	if !exists {
		t.Error("Expected file to exist")
	}
}

func TestFilesystemRetrieve(t *testing.T) {
	tmpDir := t.TempDir()

	fs, err := NewFilesystem(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem storage: %v", err)
	}

	// Store file
	testData := []byte("test content for retrieval")
	sha256, _, err := fs.Store(context.Background(), bytes.NewReader(testData))
	if err != nil {
		t.Fatalf("Failed to store file: %v", err)
	}

	// Retrieve file
	file, info, err := fs.Retrieve(context.Background(), sha256)
	if err != nil {
		t.Fatalf("Failed to retrieve file: %v", err)
	}
	defer func() { _ = file.Close() }()

	// Read content
	content, err := io.ReadAll(file)
	if err != nil {
		t.Fatalf("Failed to read file: %v", err)
	}

	if !bytes.Equal(content, testData) {
		t.Errorf("Content mismatch: expected %v, got %v", testData, content)
	}

	if info.SHA256 != sha256 {
		t.Errorf("SHA256 mismatch: expected %s, got %s", sha256, info.SHA256)
	}

	if info.Size != int64(len(testData)) {
		t.Errorf("Size mismatch: expected %d, got %d", len(testData), info.Size)
	}
}

func TestFilesystemDelete(t *testing.T) {
	tmpDir := t.TempDir()

	fs, err := NewFilesystem(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem storage: %v", err)
	}

	// Store file
	sha256, _, err := fs.Store(context.Background(), bytes.NewReader([]byte("test")))
	if err != nil {
		t.Fatalf("Failed to store file: %v", err)
	}

	// Verify file exists
	exists, err := fs.Exists(context.Background(), sha256)
	if err != nil || !exists {
		t.Fatal("File should exist before deletion")
	}

	// Delete file
	err = fs.Delete(context.Background(), sha256)
	if err != nil {
		t.Fatalf("Failed to delete file: %v", err)
	}

	// Verify file doesn't exist
	exists, err = fs.Exists(context.Background(), sha256)
	if err != nil || exists {
		t.Error("File should not exist after deletion")
	}
}

func TestFilesystemDeduplication(t *testing.T) {
	tmpDir := t.TempDir()

	fs, err := NewFilesystem(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem storage: %v", err)
	}

	testData := []byte("identical content")

	// Store file twice
	sha256_1, _, err := fs.Store(context.Background(), bytes.NewReader(testData))
	if err != nil {
		t.Fatalf("Failed to store file first time: %v", err)
	}

	sha256_2, _, err := fs.Store(context.Background(), bytes.NewReader(testData))
	if err != nil {
		t.Fatalf("Failed to store file second time: %v", err)
	}

	// Both should have the same SHA256
	if sha256_1 != sha256_2 {
		t.Errorf("Expected same SHA256 for identical files: %s vs %s", sha256_1, sha256_2)
	}
}
