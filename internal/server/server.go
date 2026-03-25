package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"git.coldforge.xyz/coldforge/cloistr-drive/internal/auth"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/blossom"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/config"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/metadata"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/metrics"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/platform"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/quota"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/ratelimit"
	"github.com/nbd-wtf/go-nostr"
)

// Server represents the HTTP server
type Server struct {
	config         *config.Config
	blossom        *blossom.Client
	metadata       *metadata.Store
	whitelist      *auth.Whitelist
	platformClient *platform.Client
	authMiddle     *auth.AuthMiddleware
	quota          *quota.Manager
	rateLimiter    *ratelimit.Limiter
	mux            *http.ServeMux
	webDir         string
	logger         *slog.Logger

	// Download counting for max-downloads links
	downloadCounts    map[string]int
	downloadCountsMux sync.RWMutex
}

// FileMetadata represents file information returned to the frontend
type FileMetadata struct {
	SHA256        string `json:"sha256"`
	Name          string `json:"name,omitempty"`
	Size          int64  `json:"size"`
	MimeType      string `json:"mime_type,omitempty"`
	FolderID      string `json:"folder_id,omitempty"`
	CreatedAt     int64  `json:"created_at,omitempty"`
	DeletedAt     int64  `json:"deleted_at,omitempty"`
	FileID        string `json:"file_id,omitempty"`
	PlaintextHash string `json:"plaintext_hash,omitempty"`
	Encrypted     bool   `json:"encrypted,omitempty"`
	EncryptedSize int64  `json:"encrypted_size,omitempty"`
}

// FolderMetadataResponse represents folder information returned to the frontend
type FolderMetadataResponse struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ParentID     string `json:"parent_id,omitempty"`
	CreatedAt    int64  `json:"created_at,omitempty"`
	EncryptedKey string `json:"encrypted_key,omitempty"`
}

// ShareResponse represents a file share returned to the frontend
type ShareResponse struct {
	ID              string `json:"id"`
	FileID          string `json:"file_id"`
	FileSHA256      string `json:"file_sha256,omitempty"`
	FileName        string `json:"file_name,omitempty"`
	FileSize        int64  `json:"file_size,omitempty"`
	FileMimeType    string `json:"file_mime_type,omitempty"`
	OwnerPubkey     string `json:"owner_pubkey"`
	RecipientPubkey string `json:"recipient_pubkey"`
	Permission      string `json:"permission,omitempty"`
	ExpiresAt       int64  `json:"expires_at,omitempty"`
	CreatedAt       int64  `json:"created_at"`
	// EncryptedContent holds the NIP-04 encrypted share details (for recipient to decrypt)
	EncryptedContent string `json:"encrypted_content,omitempty"`
}

// PublicLinkResponse represents a public link metadata
type PublicLinkResponse struct {
	ID           string `json:"id"`
	SHA256       string `json:"sha256"`
	FileName     string `json:"file_name,omitempty"`
	FileSize     int64  `json:"file_size,omitempty"`
	FileMimeType string `json:"file_mime_type,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
	MaxDownloads int    `json:"max_downloads,omitempty"`
	Downloads    int    `json:"downloads,omitempty"`
	CreatedAt    int64  `json:"created_at"`
}

// truncateForLog safely truncates a string for logging, avoiding panics on short strings
func truncateForLog(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

// New creates a new HTTP server
func New(cfg *config.Config, blossomClient *blossom.Client, metadataStore *metadata.Store, whitelist *auth.Whitelist, platformClient *platform.Client, quotaManager *quota.Manager, rateLimiter *ratelimit.Limiter, webDir string, logger *slog.Logger) *Server {
	// Create auth middleware with appropriate mode
	var authMiddle *auth.AuthMiddleware
	if platformClient != nil {
		authMiddle = auth.NewAuthMiddlewareWithPlatform(whitelist, platformClient, logger)
	} else {
		authMiddle = auth.NewAuthMiddleware(whitelist, logger)
	}

	s := &Server{
		config:         cfg,
		blossom:        blossomClient,
		metadata:       metadataStore,
		whitelist:      whitelist,
		platformClient: platformClient,
		authMiddle:     authMiddle,
		quota:          quotaManager,
		rateLimiter:    rateLimiter,
		mux:            http.NewServeMux(),
		webDir:         webDir,
		logger:         logger,
		downloadCounts: make(map[string]int),
	}

	s.registerRoutes()
	return s
}

// registerRoutes registers all HTTP endpoints
func (s *Server) registerRoutes() {
	// Health check
	s.mux.HandleFunc("GET /health", s.handleHealth)

	// Metrics endpoint
	s.mux.Handle("GET /metrics", metrics.Handler())

	// Auth status endpoint (public)
	s.mux.HandleFunc("GET /api/auth/status", s.authMiddle.HandleAuthStatus)

	// API endpoints - file operations
	// List files is public (filtered by pubkey query param)
	s.mux.HandleFunc("GET /api/files", s.handleListFiles)

	// Upload requires whitelist authorization
	s.mux.Handle("POST /api/files", s.authMiddle.RequireWhitelist(http.HandlerFunc(s.handleUploadFile)))

	// Get file metadata is public
	s.mux.HandleFunc("GET /api/files/{sha256}", s.handleGetFile)

	// Delete requires whitelist authorization
	s.mux.Handle("DELETE /api/files/{sha256}", s.authMiddle.RequireWhitelist(http.HandlerFunc(s.handleDeleteFile)))

	// Download is public
	s.mux.HandleFunc("GET /api/files/{sha256}/download", s.handleDownloadFile)

	// Metadata publish requires whitelist authorization
	s.mux.Handle("POST /api/metadata", s.authMiddle.RequireWhitelist(http.HandlerFunc(s.handlePublishMetadata)))

	// API endpoints - folder operations
	// List folders is public (filtered by pubkey query param)
	s.mux.HandleFunc("GET /api/folders", s.handleListFolders)

	// Create folder requires whitelist authorization
	s.mux.Handle("POST /api/folders", s.authMiddle.RequireWhitelist(http.HandlerFunc(s.handleCreateFolder)))

	// Get folder is public
	s.mux.HandleFunc("GET /api/folders/{id}", s.handleGetFolder)

	// Delete folder requires whitelist authorization
	s.mux.Handle("DELETE /api/folders/{id}", s.authMiddle.RequireWhitelist(http.HandlerFunc(s.handleDeleteFolder)))

	// API endpoints - share operations
	// List shares (both created and received)
	s.mux.HandleFunc("GET /api/shares", s.handleListShares)

	// Create share requires whitelist authorization
	s.mux.Handle("POST /api/shares", s.authMiddle.RequireWhitelist(http.HandlerFunc(s.handleCreateShare)))

	// Revoke share requires whitelist authorization
	s.mux.Handle("DELETE /api/shares/{id}", s.authMiddle.RequireWhitelist(http.HandlerFunc(s.handleRevokeShare)))

	// Public links - anonymous access
	// GET /public/{id} - access a public link (serves download page with blob info)
	s.mux.HandleFunc("GET /public/{id}", s.handlePublicLink)

	// GET /api/public/{id} - get public link metadata (JSON, for client-side decryption)
	s.mux.HandleFunc("GET /api/public/{id}", s.handlePublicLinkAPI)

	// Quota endpoints
	s.mux.HandleFunc("GET /api/quota", s.handleGetQuota)

	// Keyring endpoint - get root key event (requires authorization)
	s.mux.HandleFunc("GET /api/keyring", s.handleGetKeyring)

	// Serve static files (web UI)
	s.mux.HandleFunc("/", s.handleStatic)
}

// Handler returns the HTTP handler with middleware chain
func (s *Server) Handler() http.Handler {
	var handler http.Handler = s.mux

	// Apply rate limiting middleware if enabled
	if s.rateLimiter != nil {
		handler = s.rateLimiter.Middleware(handler)
	}

	// Apply metrics middleware
	handler = metrics.Middleware(handler)

	return handler
}

// ListenAndServe starts the HTTP server
func (s *Server) ListenAndServe(addr string) error {
	return http.ListenAndServe(addr, s.Handler())
}

// handleHealth is the health check endpoint
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Check metadata store health (relay connection)
	if s.metadata != nil && !s.metadata.IsHealthy() {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, `{"status":"unhealthy","reason":"relay connection failed"}`)
		return
	}

	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprint(w, `{"status":"healthy"}`)
}

// handleStatic serves the web UI files
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	// Clean the path
	path := r.URL.Path
	if path == "/" {
		path = "/index.html"
	}

	// Prevent directory traversal
	path = filepath.Clean(path)
	if strings.Contains(path, "..") {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	filePath := filepath.Join(s.webDir, path)

	// Check if file exists
	info, err := os.Stat(filePath)
	if os.IsNotExist(err) {
		// For SPA routing, serve index.html for unknown paths
		if !strings.Contains(path, ".") {
			filePath = filepath.Join(s.webDir, "index.html")
		} else {
			http.NotFound(w, r)
			return
		}
	} else if err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	} else if info.IsDir() {
		// Try index.html in directory
		filePath = filepath.Join(filePath, "index.html")
	}

	// Set correct MIME type and cache headers for certain files
	switch {
	case strings.HasSuffix(filePath, ".svg"):
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400") // 1 day for images
	case strings.HasSuffix(filePath, "sw.js"):
		// Service worker must always be revalidated
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	case strings.HasSuffix(filePath, ".js"):
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "public, max-age=300, must-revalidate") // 5 min for JS
	case strings.HasSuffix(filePath, ".css"):
		w.Header().Set("Content-Type", "text/css")
		w.Header().Set("Cache-Control", "public, max-age=300, must-revalidate") // 5 min for CSS
	case strings.HasSuffix(filePath, ".json"):
		w.Header().Set("Content-Type", "application/json")
	case strings.HasSuffix(filePath, ".png"):
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400") // 1 day for images
	case strings.HasSuffix(filePath, ".ico"):
		w.Header().Set("Content-Type", "image/x-icon")
		w.Header().Set("Cache-Control", "public, max-age=86400") // 1 day for images
	}

	http.ServeFile(w, r, filePath)
}

// handleListFiles returns all files for a given pubkey from Nostr relay
// Supports optional folder query param to filter by folder
func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		// Return empty list if no pubkey specified
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"files":[]}`)
		return
	}

	// Query metadata from relay
	if s.metadata == nil {
		s.logger.Warn("metadata store not configured")
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"files":[]}`)
		return
	}

	// Check if folder filter is specified
	folderID := r.URL.Query().Get("folder")
	var files []*metadata.FileMetadata
	var err error

	if r.URL.Query().Has("folder") {
		// Filter by folder (empty string = root folder)
		files, err = s.metadata.ListFilesInFolder(r.Context(), pubkey, folderID)
	} else {
		// List all files
		files, err = s.metadata.ListFiles(r.Context(), pubkey)
	}

	if err != nil {
		s.logger.Error("failed to list files from relay",
			"error", err,
			"pubkey", truncateForLog(pubkey, 16),
		)
		// Return empty list on error rather than failing
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"files":[]}`)
		return
	}

	// Convert to response format
	response := struct {
		Files []FileMetadata `json:"files"`
	}{
		Files: make([]FileMetadata, 0, len(files)),
	}

	for _, f := range files {
		response.Files = append(response.Files, FileMetadata{
			SHA256:        f.SHA256,
			Name:          f.Name,
			Size:          f.Size,
			MimeType:      f.MimeType,
			FolderID:      f.FolderID,
			CreatedAt:     f.CreatedAt.Unix(),
			DeletedAt:     f.DeletedAt,
			FileID:        f.FileID,
			PlaintextHash: f.PlaintextHash,
			Encrypted:     f.Encrypted,
			EncryptedSize: f.EncryptedSize,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

// handleUploadFile handles file uploads
func (s *Server) handleUploadFile(w http.ResponseWriter, r *http.Request) {
	// Parse multipart form
	if err := r.ParseMultipartForm(100 << 20); err != nil { // 100MB max
		s.logger.Warn("failed to parse multipart form", "error", err)
		http.Error(w, "Failed to parse form", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		s.logger.Warn("no file in upload request", "error", err)
		http.Error(w, "No file provided", http.StatusBadRequest)
		return
	}
	defer func() { _ = file.Close() }()

	// Get Blossom auth header from request
	authHeader := r.Header.Get("X-Blossom-Auth")

	// Get encryption mode header (e2e, server, or none)
	encryptionMode := r.Header.Get("X-Encryption")
	if encryptionMode == "" {
		encryptionMode = "e2e" // Default to e2e for Drive uploads (always client-encrypted)
	}

	// Extract pubkey from auth header for quota check
	pubkey := extractPubkeyFromAuth(authHeader)

	// Check quota before upload
	if s.quota != nil && s.quota.IsEnabled() && pubkey != "" {
		if err := s.quota.CheckQuota(pubkey, header.Size); err != nil {
			s.logger.Warn("quota exceeded",
				"pubkey", pubkey[:min(16, len(pubkey))],
				"file_size", header.Size,
				"error", err,
			)
			http.Error(w, "Storage quota exceeded", http.StatusForbidden)
			return
		}
	}

	// Detect content type
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Upload to Blossom with auth and encryption mode
	result, err := s.blossom.Upload(r.Context(), file, contentType, authHeader, encryptionMode)
	if err != nil {
		s.logger.Error("failed to upload to blossom",
			"error", err,
			"filename", header.Filename,
			"content_type", contentType,
			"encryption_mode", encryptionMode,
		)
		metrics.RecordUpload(false, 0)
		http.Error(w, "Upload failed", http.StatusInternalServerError)
		return
	}

	// Record successful upload
	metrics.RecordUpload(true, result.Size)

	// Update quota usage
	if s.quota != nil && pubkey != "" {
		s.quota.AddUsage(pubkey, result.Size)
	}

	// Create response with file metadata
	fileMeta := FileMetadata{
		SHA256:   result.SHA256,
		Name:     header.Filename,
		Size:     result.Size,
		MimeType: contentType,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(fileMeta)

	s.logger.Info("file uploaded",
		"filename", header.Filename,
		"sha256", result.SHA256[:16],
		"size", result.Size,
		"content_type", contentType,
		"encryption_mode", encryptionMode,
	)
}

// handleGetFile returns file metadata
func (s *Server) handleGetFile(w http.ResponseWriter, r *http.Request) {
	sha256 := r.PathValue("sha256")
	if sha256 == "" {
		http.Error(w, "SHA256 required", http.StatusBadRequest)
		return
	}

	// Check if file exists in Blossom
	exists, err := s.blossom.Exists(r.Context(), sha256)
	if err != nil {
		s.logger.Error("failed to check file existence",
			"error", err,
			"sha256", sha256,
		)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if !exists {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Return basic metadata (we'll add more when we have Nostr metadata)
	metadata := FileMetadata{
		SHA256: sha256,
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(metadata)
}

// handleDeleteFile deletes a file
func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	sha256 := r.PathValue("sha256")
	if sha256 == "" {
		http.Error(w, "SHA256 required", http.StatusBadRequest)
		return
	}

	// Get Blossom auth header from request
	authHeader := r.Header.Get("X-Blossom-Auth")
	pubkey := extractPubkeyFromAuth(authHeader)

	// Get file size before deletion for quota update
	var fileSize int64
	if s.metadata != nil && s.quota != nil && pubkey != "" {
		if fileMeta, err := s.metadata.GetFileBySHA256(r.Context(), sha256); err == nil && fileMeta != nil {
			fileSize = fileMeta.Size
		}
	}

	// Delete from Blossom with auth
	if err := s.blossom.Delete(r.Context(), sha256, authHeader); err != nil {
		s.logger.Error("failed to delete file",
			"error", err,
			"sha256", sha256,
		)
		http.Error(w, "Delete failed", http.StatusInternalServerError)
		return
	}

	// Update quota usage
	if s.quota != nil && pubkey != "" && fileSize > 0 {
		s.quota.RemoveUsage(pubkey, fileSize)
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprint(w, `{"status":"deleted"}`)

	s.logger.Info("file deleted", "sha256", sha256)
}

// handleDownloadFile proxies file download from Blossom
func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	sha256 := r.PathValue("sha256")
	if sha256 == "" {
		http.Error(w, "SHA256 required", http.StatusBadRequest)
		return
	}

	// Check if this is a public link download with max downloads limit
	// The client can pass a max_downloads query param to enforce the limit
	maxDownloadsStr := r.URL.Query().Get("max_downloads")
	if maxDownloadsStr != "" {
		var maxDownloads int
		_, _ = fmt.Sscanf(maxDownloadsStr, "%d", &maxDownloads)

		if maxDownloads > 0 {
			currentCount := s.getDownloadCount(sha256)
			if currentCount >= maxDownloads {
				s.logger.Info("max downloads reached for public link",
					"sha256", sha256[:16],
					"max", maxDownloads,
					"current", currentCount,
				)
				http.Error(w, "Download limit reached", http.StatusForbidden)
				return
			}
		}
	}

	// Download from Blossom
	body, info, err := s.blossom.Download(r.Context(), sha256)
	if err != nil {
		s.logger.Warn("failed to download file",
			"error", err,
			"sha256", sha256,
		)
		metrics.RecordDownload(false)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer func() { _ = body.Close() }()

	// Record successful download
	metrics.RecordDownload(true)

	// Increment download count for public links
	if r.URL.Query().Has("public") || maxDownloadsStr != "" {
		newCount := s.incrementDownloadCount(sha256)
		s.logger.Info("public link download",
			"sha256", sha256[:16],
			"count", newCount,
		)
	}

	// Set headers
	if info.MimeType != "" {
		w.Header().Set("Content-Type", info.MimeType)
	}
	if info.Size > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size))
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", sha256))

	// Stream file
	if _, err := io.Copy(w, body); err != nil {
		s.logger.Error("failed to stream file",
			"error", err,
			"sha256", sha256,
		)
	}
}

// handlePublishMetadata publishes a signed file metadata event to the relay
func (s *Server) handlePublishMetadata(w http.ResponseWriter, r *http.Request) {
	if s.metadata == nil {
		http.Error(w, "Metadata storage not configured", http.StatusServiceUnavailable)
		return
	}

	// Parse the signed event from request body
	var event nostr.Event
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		s.logger.Warn("failed to decode metadata event", "error", err)
		http.Error(w, "Invalid event format", http.StatusBadRequest)
		return
	}

	// Validate event kind
	if event.Kind != metadata.KindFileMetadata {
		http.Error(w, fmt.Sprintf("Invalid event kind: expected %d", metadata.KindFileMetadata), http.StatusBadRequest)
		return
	}

	// Verify signature
	ok, err := event.CheckSignature()
	if err != nil || !ok {
		s.logger.Warn("invalid event signature",
			"event_id", event.ID,
			"error", err,
		)
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	// Publish to relay
	if err := s.metadata.PublishFile(r.Context(), &event); err != nil {
		s.logger.Error("failed to publish metadata",
			"error", err,
			"event_id", event.ID,
		)
		http.Error(w, "Failed to publish metadata", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":   "published",
		"event_id": event.ID,
	})

	s.logger.Info("metadata published",
		"event_id", event.ID[:16],
		"pubkey", event.PubKey[:16],
	)
}

// extractPubkeyFromAuth extracts the pubkey from a Blossom auth header
// Format: "Nostr <base64-encoded-signed-event>"
func extractPubkeyFromAuth(authHeader string) string {
	if !strings.HasPrefix(authHeader, "Nostr ") {
		return ""
	}

	eventB64 := strings.TrimPrefix(authHeader, "Nostr ")
	eventJSON, err := base64.StdEncoding.DecodeString(eventB64)
	if err != nil {
		return ""
	}

	var event nostr.Event
	if err := json.Unmarshal(eventJSON, &event); err != nil {
		return ""
	}

	return event.PubKey
}

// handleListFolders returns all folders for a given pubkey
func (s *Server) handleListFolders(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"folders":[]}`)
		return
	}

	if s.metadata == nil {
		s.logger.Warn("metadata store not configured")
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"folders":[]}`)
		return
	}

	// Optional parent filter
	parentID := r.URL.Query().Get("parent")

	folders, err := s.metadata.ListFolders(r.Context(), pubkey)
	if err != nil {
		s.logger.Error("failed to list folders from relay",
			"error", err,
			"pubkey", truncateForLog(pubkey, 16),
		)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"folders":[]}`)
		return
	}

	// Convert to response format, filtering by parent if specified
	response := struct {
		Folders []FolderMetadataResponse `json:"folders"`
	}{
		Folders: make([]FolderMetadataResponse, 0, len(folders)),
	}

	for _, f := range folders {
		// Filter by parent if specified
		if r.URL.Query().Has("parent") && f.ParentID != parentID {
			continue
		}

		response.Folders = append(response.Folders, FolderMetadataResponse{
			ID:           f.Identifier,
			Name:         f.Name,
			ParentID:     f.ParentID,
			CreatedAt:    f.CreatedAt.Unix(),
			EncryptedKey: f.EncryptedKey,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

// handleCreateFolder creates a new folder by publishing a signed folder metadata event
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	if s.metadata == nil {
		http.Error(w, "Metadata storage not configured", http.StatusServiceUnavailable)
		return
	}

	// Parse the signed event from request body
	var event nostr.Event
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		s.logger.Warn("failed to decode folder event", "error", err)
		http.Error(w, "Invalid event format", http.StatusBadRequest)
		return
	}

	// Validate event kind
	if event.Kind != metadata.KindFolderMetadata {
		http.Error(w, fmt.Sprintf("Invalid event kind: expected %d", metadata.KindFolderMetadata), http.StatusBadRequest)
		return
	}

	// Verify signature
	ok, err := event.CheckSignature()
	if err != nil || !ok {
		s.logger.Warn("invalid folder event signature",
			"event_id", event.ID,
			"error", err,
		)
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	// Publish to relay
	if err := s.metadata.PublishFolder(r.Context(), &event); err != nil {
		s.logger.Error("failed to publish folder metadata",
			"error", err,
			"event_id", event.ID,
		)
		http.Error(w, "Failed to create folder", http.StatusInternalServerError)
		return
	}

	// Parse the event to return folder info
	folder, _ := metadata.ParseFolderEvent(&event)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(FolderMetadataResponse{
		ID:           folder.Identifier,
		Name:         folder.Name,
		ParentID:     folder.ParentID,
		CreatedAt:    folder.CreatedAt.Unix(),
		EncryptedKey: folder.EncryptedKey,
	})

	s.logger.Info("folder created",
		"event_id", event.ID[:16],
		"pubkey", event.PubKey[:16],
		"name", folder.Name,
	)
}

// handleGetFolder returns a specific folder's metadata
func (s *Server) handleGetFolder(w http.ResponseWriter, r *http.Request) {
	folderID := r.PathValue("id")
	if folderID == "" {
		http.Error(w, "Folder ID required", http.StatusBadRequest)
		return
	}

	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		http.Error(w, "Pubkey required", http.StatusBadRequest)
		return
	}

	if s.metadata == nil {
		http.Error(w, "Metadata storage not configured", http.StatusServiceUnavailable)
		return
	}

	folder, err := s.metadata.GetFolder(r.Context(), pubkey, folderID)
	if err != nil {
		s.logger.Warn("folder not found",
			"folder_id", folderID,
			"pubkey", truncateForLog(pubkey, 16),
			"error", err,
		)
		http.Error(w, "Folder not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(FolderMetadataResponse{
		ID:           folder.Identifier,
		Name:         folder.Name,
		ParentID:     folder.ParentID,
		CreatedAt:    folder.CreatedAt.Unix(),
		EncryptedKey: folder.EncryptedKey,
	})
}

// handleDeleteFolder deletes a folder by publishing a deletion event
func (s *Server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	folderID := r.PathValue("id")
	if folderID == "" {
		http.Error(w, "Folder ID required", http.StatusBadRequest)
		return
	}

	if s.metadata == nil {
		http.Error(w, "Metadata storage not configured", http.StatusServiceUnavailable)
		return
	}

	// Parse the signed deletion event from request body
	var event nostr.Event
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		s.logger.Warn("failed to decode deletion event", "error", err)
		http.Error(w, "Invalid event format", http.StatusBadRequest)
		return
	}

	// Validate event kind (should be deletion event kind 5)
	if event.Kind != 5 {
		http.Error(w, "Invalid event kind: expected 5 (deletion)", http.StatusBadRequest)
		return
	}

	// Verify signature
	ok, err := event.CheckSignature()
	if err != nil || !ok {
		s.logger.Warn("invalid deletion event signature",
			"event_id", event.ID,
			"error", err,
		)
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	// Publish deletion event to relay
	if err := s.metadata.DeleteFile(r.Context(), &event); err != nil {
		s.logger.Error("failed to publish folder deletion",
			"error", err,
			"folder_id", folderID,
		)
		http.Error(w, "Failed to delete folder", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprint(w, `{"status":"deleted"}`)

	s.logger.Info("folder deleted", "folder_id", folderID)
}

// handleListShares returns shares for the current user
// Query params: pubkey (required), type=created|received|all (default: all)
func (s *Server) handleListShares(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"shares":[],"received":[]}`)
		return
	}

	if s.metadata == nil {
		s.logger.Warn("metadata store not configured")
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"shares":[],"received":[]}`)
		return
	}

	shareType := r.URL.Query().Get("type")
	if shareType == "" {
		shareType = "all"
	}

	response := struct {
		Shares   []ShareResponse `json:"shares"`
		Received []ShareResponse `json:"received"`
	}{
		Shares:   make([]ShareResponse, 0),
		Received: make([]ShareResponse, 0),
	}

	// Get shares created by this user
	if shareType == "all" || shareType == "created" {
		shares, err := s.metadata.ListMyShares(r.Context(), pubkey)
		if err != nil {
			s.logger.Error("failed to list created shares", "error", err)
		} else {
			for _, share := range shares {
				response.Shares = append(response.Shares, ShareResponse{
					ID:              share.Identifier,
					FileID:          share.FileIdentifier,
					OwnerPubkey:     share.OwnerPubkey,
					RecipientPubkey: share.RecipientPubkey,
					Permission:      share.Permission,
					ExpiresAt:       share.ExpiresAt.Unix(),
					CreatedAt:       share.CreatedAt.Unix(),
				})
			}
		}
	}

	// Get shares received by this user
	if shareType == "all" || shareType == "received" {
		received, err := s.metadata.ListSharedWithMe(r.Context(), pubkey)
		if err != nil {
			s.logger.Error("failed to list received shares", "error", err)
		} else {
			for _, share := range received {
				response.Received = append(response.Received, ShareResponse{
					ID:               share.Identifier,
					FileID:           share.FileIdentifier,
					OwnerPubkey:      share.OwnerPubkey,
					RecipientPubkey:  share.RecipientPubkey,
					Permission:       share.Permission,
					ExpiresAt:        share.ExpiresAt.Unix(),
					CreatedAt:        share.CreatedAt.Unix(),
					EncryptedContent: share.Message, // NIP-04 encrypted content for recipient
				})
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

// handleCreateShare creates a new file share
func (s *Server) handleCreateShare(w http.ResponseWriter, r *http.Request) {
	if s.metadata == nil {
		http.Error(w, "Metadata storage not configured", http.StatusServiceUnavailable)
		return
	}

	// Parse the signed share event from request body
	var event nostr.Event
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		s.logger.Warn("failed to decode share event", "error", err)
		http.Error(w, "Invalid event format", http.StatusBadRequest)
		return
	}

	// Validate event kind
	if event.Kind != metadata.KindFileShare {
		http.Error(w, fmt.Sprintf("Invalid event kind: expected %d", metadata.KindFileShare), http.StatusBadRequest)
		return
	}

	// Verify signature
	ok, err := event.CheckSignature()
	if err != nil || !ok {
		s.logger.Warn("invalid share event signature",
			"event_id", event.ID,
			"error", err,
		)
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	// Publish to relay
	if err := s.metadata.PublishShare(r.Context(), &event); err != nil {
		s.logger.Error("failed to publish share",
			"error", err,
			"event_id", event.ID,
		)
		http.Error(w, "Failed to create share", http.StatusInternalServerError)
		return
	}

	// Parse the event to return share info
	share, _ := metadata.ParseShareEvent(&event)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ShareResponse{
		ID:              share.Identifier,
		FileID:          share.FileIdentifier,
		OwnerPubkey:     share.OwnerPubkey,
		RecipientPubkey: share.RecipientPubkey,
		Permission:      share.Permission,
		CreatedAt:       share.CreatedAt.Unix(),
	})

	s.logger.Info("share created",
		"event_id", event.ID[:16],
		"owner", event.PubKey[:16],
		"recipient", share.RecipientPubkey[:16],
	)
}

// handleRevokeShare revokes a file share
func (s *Server) handleRevokeShare(w http.ResponseWriter, r *http.Request) {
	shareID := r.PathValue("id")
	if shareID == "" {
		http.Error(w, "Share ID required", http.StatusBadRequest)
		return
	}

	if s.metadata == nil {
		http.Error(w, "Metadata storage not configured", http.StatusServiceUnavailable)
		return
	}

	// Parse the signed deletion event from request body
	var event nostr.Event
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		s.logger.Warn("failed to decode deletion event", "error", err)
		http.Error(w, "Invalid event format", http.StatusBadRequest)
		return
	}

	// Validate event kind
	if event.Kind != 5 {
		http.Error(w, "Invalid event kind: expected 5 (deletion)", http.StatusBadRequest)
		return
	}

	// Verify signature
	ok, err := event.CheckSignature()
	if err != nil || !ok {
		s.logger.Warn("invalid deletion event signature",
			"event_id", event.ID,
			"error", err,
		)
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	// Publish deletion event to relay
	if err := s.metadata.DeleteFile(r.Context(), &event); err != nil {
		s.logger.Error("failed to publish share revocation",
			"error", err,
			"share_id", shareID,
		)
		http.Error(w, "Failed to revoke share", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprint(w, `{"status":"revoked"}`)

	s.logger.Info("share revoked", "share_id", shareID)
}

// KeyringResponse represents the response from the keyring endpoint
type KeyringResponse struct {
	EncryptedRootKey string `json:"encrypted_root_key,omitempty"`
}

// handleGetKeyring retrieves the user's encrypted root key from Nostr
func (s *Server) handleGetKeyring(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		http.Error(w, "pubkey parameter required", http.StatusBadRequest)
		return
	}

	// Validate pubkey format (64 hex chars)
	if len(pubkey) != 64 {
		http.Error(w, "Invalid pubkey format", http.StatusBadRequest)
		return
	}

	encryptedKey, err := s.metadata.GetRootKey(r.Context(), pubkey)
	if err != nil {
		s.logger.Error("failed to get root key",
			"error", err,
			"pubkey", truncateForLog(pubkey, 16),
		)
		http.Error(w, "Failed to get root key", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(KeyringResponse{
		EncryptedRootKey: encryptedKey,
	})
}

// handlePublicLink serves the public link access page
// The decryption key is in the URL fragment (never sent to server)
// Format: /public/{sha256}#<base64url-key>
func (s *Server) handlePublicLink(w http.ResponseWriter, r *http.Request) {
	sha256 := r.PathValue("id")
	if sha256 == "" {
		http.Error(w, "Link ID required", http.StatusBadRequest)
		return
	}

	// Check if file exists in Blossom
	exists, err := s.blossom.Exists(r.Context(), sha256)
	if err != nil {
		s.logger.Error("failed to check file existence for public link",
			"error", err,
			"sha256", sha256,
		)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if !exists {
		http.Error(w, "File not found or link expired", http.StatusNotFound)
		return
	}

	// Serve a simple download page
	// The client-side JS will extract the key from the URL fragment and decrypt
	html := `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloistr Drive - Shared File</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .container { text-align: center; padding: 2rem; max-width: 600px; }
        .logo { font-size: 2rem; margin-bottom: 1rem; }
        h1 { font-size: 1.5rem; margin-bottom: 1rem; }
        p { color: #aaa; margin-bottom: 2rem; }
        .btn { background: #6366f1; color: white; border: none; padding: 1rem 2rem; border-radius: 8px; font-size: 1rem; cursor: pointer; }
        .btn:hover { background: #4f46e5; }
        .btn:disabled { background: #444; cursor: not-allowed; }
        .status { margin-top: 1rem; font-size: 0.9rem; color: #888; }
        .error { color: #ef4444; }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">🔐</div>
        <h1>Encrypted File</h1>
        <p>This file is end-to-end encrypted. Click download to decrypt and save.</p>
        <button class="btn" id="download-btn" onclick="downloadAndDecrypt()">Download & Decrypt</button>
        <div class="status" id="status"></div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/sodium.js"></script>
    <script>
        const sha256 = '` + sha256 + `';
        const downloadUrl = '/api/files/' + sha256 + '/download';
        const metadataUrl = '/api/public/' + sha256;
        let fileMetadata = null;

        // Try to get file metadata on page load
        (async function() {
            try {
                const resp = await fetch(metadataUrl);
                if (resp.ok) {
                    fileMetadata = await resp.json();
                    if (fileMetadata.name) {
                        document.querySelector('h1').textContent = fileMetadata.name;
                    }
                }
            } catch (e) {
                console.log('Could not fetch metadata');
            }
        })();

        async function downloadAndDecrypt() {
            const btn = document.getElementById('download-btn');
            const status = document.getElementById('status');

            // Get key from URL fragment
            const keyB64 = window.location.hash.slice(1);
            if (!keyB64) {
                status.className = 'status error';
                status.textContent = 'Error: No decryption key in URL';
                return;
            }

            btn.disabled = true;
            status.textContent = 'Downloading encrypted file...';

            try {
                // Initialize libsodium
                await window.sodium.ready;
                const sodium = window.sodium;

                // Decode key from base64url
                const key = base64urlToBytes(keyB64);
                if (key.length !== 32) {
                    throw new Error('Invalid key length');
                }

                // Download encrypted file
                const response = await fetch(downloadUrl);
                if (!response.ok) throw new Error('Download failed: ' + response.status);

                status.textContent = 'Decrypting...';
                const encrypted = new Uint8Array(await response.arrayBuffer());

                // Decrypt (nonce is prepended to ciphertext)
                const nonce = encrypted.slice(0, sodium.crypto_secretbox_NONCEBYTES);
                const ciphertext = encrypted.slice(sodium.crypto_secretbox_NONCEBYTES);
                const decrypted = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);

                // Get filename from metadata or use default
                const filename = (fileMetadata && fileMetadata.name) || 'download';
                const mimeType = (fileMetadata && fileMetadata.mime_type) || 'application/octet-stream';

                // Trigger download
                const blob = new Blob([decrypted], { type: mimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                status.textContent = 'Download complete!';

            } catch (err) {
                status.className = 'status error';
                status.textContent = 'Error: ' + err.message;
            } finally {
                btn.disabled = false;
            }
        }

        function base64urlToBytes(str) {
            str = str.replace(/-/g, '+').replace(/_/g, '/');
            while (str.length % 4) str += '=';
            const binary = atob(str);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        }
    </script>
</body>
</html>`

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprint(w, html)

	s.logger.Info("public link accessed", "sha256", sha256[:16])
}

// handlePublicLinkAPI returns JSON metadata for a public link
// Used by the client to check validity before decrypting
func (s *Server) handlePublicLinkAPI(w http.ResponseWriter, r *http.Request) {
	sha256 := r.PathValue("id")
	if sha256 == "" {
		http.Error(w, "Link ID required", http.StatusBadRequest)
		return
	}

	// Check if file exists in Blossom
	exists, err := s.blossom.Exists(r.Context(), sha256)
	if err != nil {
		s.logger.Error("failed to check file existence for public link",
			"error", err,
			"sha256", sha256,
		)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if !exists {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprint(w, `{"error":"not_found","message":"File not found or link expired"}`)
		return
	}

	// Get download count
	s.downloadCountsMux.RLock()
	downloads := s.downloadCounts[sha256]
	s.downloadCountsMux.RUnlock()

	// Try to get file metadata from relay
	response := PublicLinkResponse{
		ID:        sha256,
		SHA256:    sha256,
		Downloads: downloads,
		CreatedAt: 0,
	}

	// Query metadata store for file info (if available)
	if s.metadata != nil {
		fileMeta, err := s.metadata.GetFileBySHA256(r.Context(), sha256)
		if err == nil && fileMeta != nil {
			response.FileName = fileMeta.Name
			response.FileSize = fileMeta.Size
			response.FileMimeType = fileMeta.MimeType
			response.CreatedAt = fileMeta.CreatedAt.Unix()
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

// incrementDownloadCount increments and returns the new count for a public link
func (s *Server) incrementDownloadCount(sha256 string) int {
	s.downloadCountsMux.Lock()
	defer s.downloadCountsMux.Unlock()

	s.downloadCounts[sha256]++
	return s.downloadCounts[sha256]
}

// getDownloadCount returns the current download count for a public link
func (s *Server) getDownloadCount(sha256 string) int {
	s.downloadCountsMux.RLock()
	defer s.downloadCountsMux.RUnlock()

	return s.downloadCounts[sha256]
}

// QuotaResponse represents the quota information returned by the API
type QuotaResponse struct {
	Enabled   bool   `json:"enabled"`
	Used      int64  `json:"used"`
	Limit     int64  `json:"limit"`
	Available int64  `json:"available"`
	Percent   int    `json:"percent"`
	UsedHuman string `json:"used_human"`
	LimitHuman string `json:"limit_human"`
}

// handleGetQuota returns quota information for the authenticated user
func (s *Server) handleGetQuota(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		// Try to get from auth header
		authHeader := r.Header.Get("X-Blossom-Auth")
		pubkey = extractPubkeyFromAuth(authHeader)
	}

	if pubkey == "" {
		http.Error(w, "Pubkey required", http.StatusBadRequest)
		return
	}

	response := QuotaResponse{
		Enabled: false,
	}

	if s.quota != nil {
		response.Enabled = s.quota.IsEnabled()
		info := s.quota.GetQuotaInfo(pubkey)
		response.Used = info.Used
		response.Limit = info.Limit
		response.Available = info.Available
		response.Percent = info.Percent
		response.UsedHuman = quota.FormatBytes(info.Used)
		if info.Limit > 0 {
			response.LimitHuman = quota.FormatBytes(info.Limit)
		} else {
			response.LimitHuman = "Unlimited"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}
