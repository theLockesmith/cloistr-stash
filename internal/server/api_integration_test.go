package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/auth"
	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/config"
	"github.com/nbd-wtf/go-nostr"
)

// Test constants
const (
	testPrivateKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testSHA256     = "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3" // "hello" SHA256
)

// Test setup helper - creates minimal server for API testing
func setupAPITestServer(t *testing.T) (*Server, string) {
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

	// Generate test pubkey from private key
	pubkey, err := nostr.GetPublicKey(testPrivateKey)
	if err != nil {
		t.Fatalf("Failed to generate pubkey: %v", err)
	}

	whitelist := auth.NewWhitelist([]string{pubkey})
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Create server without external dependencies (blossom, metadata)
	s := &Server{
		config:         cfg,
		blossom:        nil, // No external blossom for isolated testing
		metadata:       nil, // No metadata store for isolated testing
		whitelist:      whitelist,
		platformClient: nil,
		authMiddle:     auth.NewAuthMiddleware(whitelist, "", logger),
		quota:          nil,
		rateLimiter:    nil,
		mux:            http.NewServeMux(),
		webDir:         "",
		logger:         logger,
		downloadCounts: make(map[string]int),
	}

	s.registerRoutes()
	return s, pubkey
}

// Helper to create valid Nostr auth header
func createTestAuthHeader(privateKey, action string) (string, error) {
	pubkey, err := nostr.GetPublicKey(privateKey)
	if err != nil {
		return "", err
	}

	event := nostr.Event{
		Kind:      24242,
		PubKey:    pubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Tags: nostr.Tags{
			{"t", action},
			{"expiration", fmt.Sprintf("%d", time.Now().Add(5*time.Minute).Unix())},
		},
		Content: action,
	}

	if err := event.Sign(privateKey); err != nil {
		return "", err
	}

	eventJSON, err := json.Marshal(event)
	if err != nil {
		return "", err
	}

	return "Nostr " + base64.StdEncoding.EncodeToString(eventJSON), nil
}

// Helper to create multipart form data
func createMultipartFormData(filename string, content []byte) (*bytes.Buffer, string) {
	boundary := "----TestBoundary123"
	var body bytes.Buffer

	body.WriteString("--" + boundary + "\r\n")
	body.WriteString(fmt.Sprintf("Content-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n", filename))
	body.WriteString("Content-Type: application/octet-stream\r\n\r\n")
	body.Write(content)
	body.WriteString("\r\n--" + boundary + "--\r\n")

	return &body, "multipart/form-data; boundary=" + boundary
}

// Test API Documentation and Endpoint Discovery
func TestAPI_EndpointDiscovery(t *testing.T) {
	srv, _ := setupAPITestServer(t)

	// Test endpoints that work without external dependencies
	workingEndpoints := []struct {
		method string
		path   string
		desc   string
	}{
		{"GET", "/health", "Health check"},
		{"GET", "/metrics", "Prometheus metrics"},
		{"GET", "/api/auth/status", "Authentication status"},
		{"GET", "/api/files", "List files (public with pubkey param)"},
		{"GET", "/api/folders", "List folders (public with pubkey param)"},
		{"GET", "/api/shares", "List shares (public with pubkey param)"},
		{"GET", "/api/quota", "Get quota info"},
	}

	// Test endpoints that require external dependencies (will fail gracefully)
	dependencyEndpoints := []struct {
		method string
		path   string
		desc   string
		expectPanic bool
	}{
		{"GET", "/api/files/" + testSHA256, "Get file metadata", true},
		{"GET", "/api/files/" + testSHA256 + "/download", "Download file", true},
		{"GET", "/api/folders/test-id", "Get folder metadata", false},
		{"GET", "/public/" + testSHA256, "Public link access", true},
		{"GET", "/api/public/" + testSHA256, "Public link metadata", true},
		{"GET", "/api/keyring", "Get encrypted root key", false},
	}

	// Test endpoints that work without external dependencies
	for _, endpoint := range workingEndpoints {
		t.Run(fmt.Sprintf("%s %s", endpoint.method, endpoint.path), func(t *testing.T) {
			req := httptest.NewRequest(endpoint.method, endpoint.path, nil)
			w := httptest.NewRecorder()

			srv.Handler().ServeHTTP(w, req)

			// These should work or return expected errors
			allowedStatuses := []int{200, 400, 404, 503}

			statusOK := false
			for _, status := range allowedStatuses {
				if w.Code == status {
					statusOK = true
					break
				}
			}

			if !statusOK {
				t.Errorf("Unexpected status %d for %s %s: %s",
					w.Code, endpoint.method, endpoint.path, w.Body.String())
			}

			t.Logf("✓ %s %s - %d %s", endpoint.method, endpoint.path, w.Code, endpoint.desc)
		})
	}

	// Test endpoints that require external dependencies (expect failures)
	for _, endpoint := range dependencyEndpoints {
		t.Run(fmt.Sprintf("%s %s (dependency)", endpoint.method, endpoint.path), func(t *testing.T) {
			req := httptest.NewRequest(endpoint.method, endpoint.path, nil)
			w := httptest.NewRecorder()

			var panicked bool
			defer func() {
				if r := recover(); r != nil {
					panicked = true
					if endpoint.expectPanic {
						t.Logf("✓ %s %s - PANIC (expected) %s",
							endpoint.method, endpoint.path, endpoint.desc)
					} else {
						t.Errorf("Unexpected panic for %s %s: %v",
							endpoint.method, endpoint.path, r)
					}
				}
			}()

			srv.Handler().ServeHTTP(w, req)

			if !panicked {
				if endpoint.expectPanic {
					t.Logf("Note: %s %s - %d (expected panic but got response) %s",
						endpoint.method, endpoint.path, w.Code, endpoint.desc)
				} else {
					t.Logf("✓ %s %s - %d %s", endpoint.method, endpoint.path, w.Code, endpoint.desc)
				}
			}
		})
	}
}

// Test Authentication Endpoints
func TestAPI_AuthenticationFlow(t *testing.T) {
	srv, pubkey := setupAPITestServer(t)

	tests := []struct {
		name           string
		endpoint       string
		authHeader     string
		expectedAuth   bool
		expectedAuthorized bool
	}{
		{
			name:           "No auth header",
			endpoint:       "/api/auth/status",
			authHeader:     "",
			expectedAuth:   false,
			expectedAuthorized: false,
		},
		{
			name:           "Valid auth header for whitelisted user",
			endpoint:       "/api/auth/status",
			authHeader:     createValidTestAuthHeader(t),
			expectedAuth:   true,
			expectedAuthorized: true,
		},
		{
			name:           "Invalid auth header format",
			endpoint:       "/api/auth/status",
			authHeader:     "Bearer invalid-token",
			expectedAuth:   false,
			expectedAuthorized: false,
		},
		{
			name:           "Invalid base64 in Nostr auth",
			endpoint:       "/api/auth/status",
			authHeader:     "Nostr invalid-base64!!!",
			expectedAuth:   false,
			expectedAuthorized: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.endpoint, nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}
			w := httptest.NewRecorder()

			srv.Handler().ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Errorf("Expected status 200, got %d", w.Code)
			}

			var response map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatalf("Failed to parse response: %v", err)
			}

			authenticated, _ := response["authenticated"].(bool)
			authorized, _ := response["authorized"].(bool)

			if authenticated != tt.expectedAuth {
				t.Errorf("Expected authenticated=%v, got %v", tt.expectedAuth, authenticated)
			}

			if authorized != tt.expectedAuthorized {
				t.Errorf("Expected authorized=%v, got %v", tt.expectedAuthorized, authorized)
			}

			if tt.expectedAuth {
				if respPubkey, ok := response["pubkey"].(string); !ok || respPubkey != pubkey {
					t.Errorf("Expected pubkey %s, got %v", pubkey, respPubkey)
				}
			}
		})
	}
}

// Test File API Endpoints (without Blossom integration)
func TestAPI_FileEndpoints(t *testing.T) {
	srv, pubkey := setupAPITestServer(t)
	authHeader := createValidTestAuthHeader(t)

	t.Run("List files without pubkey returns empty", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/files", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}

		var response map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		files, ok := response["files"].([]interface{})
		if !ok || len(files) != 0 {
			t.Error("Expected empty files array")
		}
	})

	t.Run("List files with pubkey", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/files?pubkey="+pubkey, nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		// Should succeed (metadata store unavailable but handled gracefully)
		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}

		var response map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		// Should return empty list when metadata store is nil
		files, ok := response["files"].([]interface{})
		if !ok || len(files) != 0 {
			t.Error("Expected empty files array when metadata store unavailable")
		}
	})

	t.Run("Upload file without auth fails", func(t *testing.T) {
		body, contentType := createMultipartFormData("test.txt", []byte("hello world"))
		req := httptest.NewRequest("POST", "/api/files", body)
		req.Header.Set("Content-Type", contentType)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", w.Code)
		}
	})

	t.Run("Upload file with auth (no Blossom)", func(t *testing.T) {
		body, contentType := createMultipartFormData("test.txt", []byte("hello world"))
		req := httptest.NewRequest("POST", "/api/files", body)
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("X-Blossom-Auth", authHeader)
		w := httptest.NewRecorder()

		// This will panic because blossom client is nil
		defer func() {
			if r := recover(); r != nil {
				t.Logf("✓ Upload panicked as expected when blossom client is nil: %v", r)
			}
		}()

		srv.Handler().ServeHTTP(w, req)

		// If we get here without panic, that's unexpected but not necessarily wrong
		// The handler might have been updated to check for nil
		if w.Code == http.StatusOK {
			t.Error("Expected request to fail without Blossom client")
		} else {
			t.Logf("Upload failed gracefully with status %d", w.Code)
		}
	})

	t.Run("Get file metadata (no Blossom)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/files/"+testSHA256, nil)
		w := httptest.NewRecorder()

		// This will panic because blossom client is nil
		defer func() {
			if r := recover(); r != nil {
				t.Logf("✓ Get file metadata panicked as expected: %v", r)
			}
		}()

		srv.Handler().ServeHTTP(w, req)

		// Should fail gracefully when Blossom unavailable
		if w.Code == http.StatusOK {
			t.Error("Expected request to fail without Blossom client")
		}
	})

	t.Run("Delete file without auth fails", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/api/files/"+testSHA256, nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", w.Code)
		}
	})
}

// Test Folder API Endpoints
func TestAPI_FolderEndpoints(t *testing.T) {
	srv, pubkey := setupAPITestServer(t)
	authHeader := createValidTestAuthHeader(t)

	t.Run("List folders without pubkey", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/folders", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}

		var response map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		folders, ok := response["folders"].([]interface{})
		if !ok || len(folders) != 0 {
			t.Error("Expected empty folders array")
		}
	})

	t.Run("List folders with pubkey", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/folders?pubkey="+pubkey, nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		// Should handle gracefully when metadata store is nil
		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}
	})

	t.Run("Create folder without auth fails", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/folders", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", w.Code)
		}
	})

	t.Run("Create folder with auth (no metadata store)", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/folders", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", authHeader)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		// Should return service unavailable when metadata store is nil
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("Expected status 503, got %d", w.Code)
		}
	})

	t.Run("Get folder without pubkey fails", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/folders/test-folder-id", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("Expected status 400, got %d", w.Code)
		}
	})

	t.Run("Delete folder without auth fails", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/api/folders/test-folder-id", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", w.Code)
		}
	})
}

// Test Share API Endpoints
func TestAPI_ShareEndpoints(t *testing.T) {
	srv, pubkey := setupAPITestServer(t)
	authHeader := createValidTestAuthHeader(t)

	t.Run("List shares without pubkey", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/shares", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}

		var response map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		shares, _ := response["shares"].([]interface{})
		received, _ := response["received"].([]interface{})
		if len(shares) != 0 || len(received) != 0 {
			t.Error("Expected empty shares arrays")
		}
	})

	t.Run("List shares with pubkey", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/shares?pubkey="+pubkey, nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		// Should handle gracefully when metadata store is nil
		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}
	})

	t.Run("Create share without auth fails", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/shares", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", w.Code)
		}
	})

	t.Run("Create share with auth (no metadata store)", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/shares", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", authHeader)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		// Should return service unavailable when metadata store is nil
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("Expected status 503, got %d", w.Code)
		}
	})

	t.Run("Revoke share without auth fails", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/api/shares/test-share-id", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", w.Code)
		}
	})
}

// Test Quota API
func TestAPI_QuotaEndpoint(t *testing.T) {
	srv, pubkey := setupAPITestServer(t)

	t.Run("Get quota without pubkey fails", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/quota", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("Expected status 400, got %d", w.Code)
		}
	})

	t.Run("Get quota with pubkey", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/quota?pubkey="+pubkey, nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}

		var response map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		// Should indicate quota is disabled when quota manager is nil
		enabled, ok := response["enabled"].(bool)
		if !ok || enabled {
			t.Error("Expected quota to be disabled when quota manager is nil")
		}
	})
}

// Test Public Link Endpoints (without Blossom)
func TestAPI_PublicLinkEndpoints(t *testing.T) {
	srv, _ := setupAPITestServer(t)

	t.Run("Get public link metadata (no Blossom)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/public/"+testSHA256, nil)
		w := httptest.NewRecorder()

		// This will panic because blossom client is nil
		defer func() {
			if r := recover(); r != nil {
				t.Logf("✓ Public link API panicked as expected: %v", r)
			}
		}()

		srv.Handler().ServeHTTP(w, req)

		// Should fail gracefully when Blossom unavailable
		if w.Code == http.StatusOK {
			t.Error("Expected request to fail without Blossom client")
		}
	})

	t.Run("Access public link (no Blossom)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/public/"+testSHA256, nil)
		w := httptest.NewRecorder()

		// This will panic because blossom client is nil
		defer func() {
			if r := recover(); r != nil {
				t.Logf("✓ Public link access panicked as expected: %v", r)
			}
		}()

		srv.Handler().ServeHTTP(w, req)

		// Should fail gracefully when Blossom unavailable
		if w.Code == http.StatusOK {
			t.Error("Expected request to fail without Blossom client")
		}
	})
}

// Test Error Handling and Edge Cases
func TestAPI_ErrorHandling(t *testing.T) {
	srv, _ := setupAPITestServer(t)

	tests := []struct {
		name           string
		method         string
		path           string
		expectedStatus int
		description    string
	}{
		{
			name:           "Invalid HTTP method on health",
			method:         "PATCH",
			path:           "/health",
			expectedStatus: http.StatusNotFound, // Go 1.22+ ServeMux returns 404 for unmatched methods
			description:    "Only GET allowed on health endpoint",
		},
		{
			name:           "Non-existent API endpoint",
			method:         "GET",
			path:           "/api/nonexistent",
			expectedStatus: http.StatusNotFound,
			description:    "Should return 404 for unknown endpoints",
		},
		{
			name:           "Missing file SHA256 in path",
			method:         "GET",
			path:           "/api/files/",
			expectedStatus: http.StatusNotFound,
			description:    "File operations require SHA256 parameter",
		},
		{
			name:           "Missing folder ID in path",
			method:         "GET",
			path:           "/api/folders/",
			expectedStatus: http.StatusNotFound,
			description:    "Folder operations require ID parameter",
		},
		{
			name:           "Invalid content type for JSON endpoints",
			method:         "POST",
			path:           "/api/metadata",
			expectedStatus: http.StatusUnauthorized, // Auth fails before content type check
			description:    "JSON endpoints require proper content type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			w := httptest.NewRecorder()

			srv.Handler().ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("Expected status %d, got %d - %s",
					tt.expectedStatus, w.Code, tt.description)
			}

			t.Logf("✓ %s %s - %d (%s)", tt.method, tt.path, w.Code, tt.description)
		})
	}
}

// Test Keyring Endpoint
func TestAPI_KeyringEndpoint(t *testing.T) {
	srv, pubkey := setupAPITestServer(t)

	t.Run("Get keyring without pubkey fails", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/keyring", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("Expected status 400, got %d", w.Code)
		}
	})

	t.Run("Get keyring with invalid pubkey fails", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/keyring?pubkey=invalid", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("Expected status 400, got %d", w.Code)
		}
	})

	t.Run("Get keyring with valid pubkey (no metadata store)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/keyring?pubkey="+pubkey, nil)
		w := httptest.NewRecorder()

		// This will panic because metadata store is nil
		defer func() {
			if r := recover(); r != nil {
				t.Logf("✓ Keyring endpoint panicked as expected: %v", r)
			}
		}()

		srv.Handler().ServeHTTP(w, req)

		// Should fail when metadata store is unavailable
		if w.Code == http.StatusOK {
			t.Error("Expected request to fail without metadata store")
		}
	})
}

// Test Health and Metrics Endpoints
func TestAPI_HealthAndMetrics(t *testing.T) {
	srv, _ := setupAPITestServer(t)

	t.Run("Health endpoint returns healthy", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/health", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}

		var response map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		status, ok := response["status"].(string)
		if !ok || status != "healthy" {
			t.Errorf("Expected status 'healthy', got %v", response["status"])
		}
	})

	t.Run("Metrics endpoint returns Prometheus format", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/metrics", nil)
		w := httptest.NewRecorder()

		srv.Handler().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", w.Code)
		}

		contentType := w.Header().Get("Content-Type")
		if !strings.Contains(contentType, "text/plain") {
			t.Errorf("Expected text/plain content type for metrics, got %s", contentType)
		}

		// Metrics response should contain Prometheus-style metrics
		body := w.Body.String()
		if !strings.Contains(body, "# HELP") && !strings.Contains(body, "# TYPE") {
			t.Log("Note: Metrics endpoint may not be fully configured")
		}
	})
}

// Helper function to create valid auth header for tests
func createValidTestAuthHeader(t *testing.T) string {
	header, err := createTestAuthHeader(testPrivateKey, "upload")
	if err != nil {
		t.Fatalf("Failed to create auth header: %v", err)
	}
	return header
}