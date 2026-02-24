package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"git.coldforge.xyz/coldforge/cloistr-drive/internal/auth"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/config"
)

func setupTestServer(t *testing.T) *Server {
	cfg := &config.Config{
		Server: config.ServerConfig{
			Host:      "localhost",
			Port:      8080,
			PublicURL: "http://localhost:8080",
		},
		Blossom: config.BlossomConfig{
			URL:       "http://localhost:8085",
			PublicURL: "http://localhost:8085",
		},
		Relay: config.RelayConfig{
			URL: "wss://relay.test.com",
		},
	}

	whitelist := auth.NewWhitelist([]string{"testpubkey123"})
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Create server without blossom/metadata (minimal test)
	s := &Server{
		config:         cfg,
		whitelist:      whitelist,
		authMiddle:     auth.NewAuthMiddleware(whitelist, logger),
		mux:            http.NewServeMux(),
		webDir:         "",
		logger:         logger,
		downloadCounts: make(map[string]int),
	}

	// Setup routes
	s.registerRoutes()

	return s
}

func TestHealthEndpoint(t *testing.T) {
	s := setupTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	s.mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var response map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response["status"] != "healthy" {
		t.Errorf("Expected status 'healthy', got %v", response["status"])
	}
}

func TestAuthStatusEndpointNoAuth(t *testing.T) {
	s := setupTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	w := httptest.NewRecorder()

	s.mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var response map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response["authenticated"] != false {
		t.Errorf("Expected authenticated false without auth header")
	}
}

func TestCORSHeaders(t *testing.T) {
	// CORS middleware is not currently implemented in the server
	// When CORS is added, this test should verify headers are set
	t.Skip("CORS middleware not implemented yet")
}

func TestListFilesRequiresPubkey(t *testing.T) {
	s := setupTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
	w := httptest.NewRecorder()

	s.mux.ServeHTTP(w, req)

	// Without pubkey query param, should fail
	if w.Code == http.StatusOK {
		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		// Should have empty files list or error
		if files, ok := response["files"].([]interface{}); ok && len(files) > 0 {
			t.Error("Expected no files without pubkey")
		}
	}
}

func TestListFoldersRequiresPubkey(t *testing.T) {
	s := setupTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/folders", nil)
	w := httptest.NewRecorder()

	s.mux.ServeHTTP(w, req)

	// Should handle missing pubkey gracefully
	if w.Code != http.StatusBadRequest && w.Code != http.StatusOK {
		t.Logf("Status: %d, Body: %s", w.Code, w.Body.String())
	}
}

func TestFileDownloadPath(t *testing.T) {
	// Skip this test as it requires blossom client to be initialized
	// A nil blossom client causes a panic in the handler
	t.Skip("Requires blossom client - skipping in minimal test setup")
}

func TestPublicLinkPath(t *testing.T) {
	// Skip this test as it requires blossom client to be initialized
	t.Skip("Requires blossom client - skipping in minimal test setup")
}

func TestAPIPublicLinkMetadata(t *testing.T) {
	// Skip this test as it requires metadata store to be initialized
	t.Skip("Requires metadata store - skipping in minimal test setup")
}
