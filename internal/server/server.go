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

	"git.coldforge.xyz/coldforge/cloistr-drive/internal/auth"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/blossom"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/config"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/metadata"
	"git.coldforge.xyz/coldforge/cloistr-drive/internal/metrics"
	"github.com/nbd-wtf/go-nostr"
)

// Server represents the HTTP server
type Server struct {
	config     *config.Config
	blossom    *blossom.Client
	metadata   *metadata.Store
	whitelist  *auth.Whitelist
	authMiddle *auth.AuthMiddleware
	mux        *http.ServeMux
	webDir     string
	logger     *slog.Logger
}

// FileMetadata represents file information returned to the frontend
type FileMetadata struct {
	SHA256    string `json:"sha256"`
	Name      string `json:"name,omitempty"`
	Size      int64  `json:"size"`
	MimeType  string `json:"mime_type,omitempty"`
	CreatedAt int64  `json:"created_at,omitempty"`
}

// New creates a new HTTP server
func New(cfg *config.Config, blossomClient *blossom.Client, metadataStore *metadata.Store, whitelist *auth.Whitelist, webDir string, logger *slog.Logger) *Server {
	s := &Server{
		config:     cfg,
		blossom:    blossomClient,
		metadata:   metadataStore,
		whitelist:  whitelist,
		authMiddle: auth.NewAuthMiddleware(whitelist, logger),
		mux:        http.NewServeMux(),
		webDir:     webDir,
		logger:     logger,
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

	// Serve static files (web UI)
	s.mux.HandleFunc("/", s.handleStatic)
}

// Handler returns the HTTP handler with metrics middleware
func (s *Server) Handler() http.Handler {
	return metrics.Middleware(s.mux)
}

// ListenAndServe starts the HTTP server
func (s *Server) ListenAndServe(addr string) error {
	return http.ListenAndServe(addr, s.Handler())
}

// handleHealth is the health check endpoint
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"status":"healthy"}`)
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

	// Set correct MIME type for certain files
	switch {
	case strings.HasSuffix(filePath, ".svg"):
		w.Header().Set("Content-Type", "image/svg+xml")
	case strings.HasSuffix(filePath, ".js"):
		w.Header().Set("Content-Type", "application/javascript")
	case strings.HasSuffix(filePath, ".css"):
		w.Header().Set("Content-Type", "text/css")
	case strings.HasSuffix(filePath, ".json"):
		w.Header().Set("Content-Type", "application/json")
	case strings.HasSuffix(filePath, ".png"):
		w.Header().Set("Content-Type", "image/png")
	case strings.HasSuffix(filePath, ".ico"):
		w.Header().Set("Content-Type", "image/x-icon")
	}

	http.ServeFile(w, r, filePath)
}

// handleListFiles returns all files for a given pubkey from Nostr relay
func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		// Return empty list if no pubkey specified
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"files":[]}`)
		return
	}

	// Query metadata from relay
	if s.metadata == nil {
		s.logger.Warn("metadata store not configured")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"files":[]}`)
		return
	}

	files, err := s.metadata.ListFiles(r.Context(), pubkey)
	if err != nil {
		s.logger.Error("failed to list files from relay",
			"error", err,
			"pubkey", pubkey[:16],
		)
		// Return empty list on error rather than failing
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"files":[]}`)
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
			SHA256:    f.SHA256,
			Name:      f.Name,
			Size:      f.Size,
			MimeType:  f.MimeType,
			CreatedAt: f.CreatedAt.Unix(),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
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
	defer file.Close()

	// Get Blossom auth header from request
	authHeader := r.Header.Get("X-Blossom-Auth")

	// Detect content type
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Upload to Blossom with auth
	result, err := s.blossom.Upload(r.Context(), file, contentType, authHeader)
	if err != nil {
		s.logger.Error("failed to upload to blossom",
			"error", err,
			"filename", header.Filename,
			"content_type", contentType,
		)
		metrics.RecordUpload(false, 0)
		http.Error(w, "Upload failed", http.StatusInternalServerError)
		return
	}

	// Record successful upload
	metrics.RecordUpload(true, result.Size)

	// Create response with file metadata
	metadata := FileMetadata{
		SHA256:   result.SHA256,
		Name:     header.Filename,
		Size:     result.Size,
		MimeType: contentType,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(metadata)

	s.logger.Info("file uploaded",
		"filename", header.Filename,
		"sha256", result.SHA256[:16],
		"size", result.Size,
		"content_type", contentType,
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
	json.NewEncoder(w).Encode(metadata)
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

	// Delete from Blossom with auth
	if err := s.blossom.Delete(r.Context(), sha256, authHeader); err != nil {
		s.logger.Error("failed to delete file",
			"error", err,
			"sha256", sha256,
		)
		http.Error(w, "Delete failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"status":"deleted"}`)

	s.logger.Info("file deleted", "sha256", sha256)
}

// handleDownloadFile proxies file download from Blossom
func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	sha256 := r.PathValue("sha256")
	if sha256 == "" {
		http.Error(w, "SHA256 required", http.StatusBadRequest)
		return
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
	defer body.Close()

	// Record successful download
	metrics.RecordDownload(true)

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
	json.NewEncoder(w).Encode(map[string]string{
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
