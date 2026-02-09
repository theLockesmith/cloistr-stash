package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"git.coldforge.xyz/coldforge/coldforge-drive/internal/blossom"
	"git.coldforge.xyz/coldforge/coldforge-drive/internal/config"
)

// Server represents the HTTP server
type Server struct {
	config  *config.Config
	blossom *blossom.Client
	mux     *http.ServeMux
	webDir  string
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
func New(cfg *config.Config, blossomClient *blossom.Client, webDir string) *Server {
	s := &Server{
		config:  cfg,
		blossom: blossomClient,
		mux:     http.NewServeMux(),
		webDir:  webDir,
	}

	s.registerRoutes()
	return s
}

// registerRoutes registers all HTTP endpoints
func (s *Server) registerRoutes() {
	// Health check
	s.mux.HandleFunc("GET /health", s.handleHealth)

	// API endpoints
	s.mux.HandleFunc("GET /api/files", s.handleListFiles)
	s.mux.HandleFunc("POST /api/files", s.handleUploadFile)
	s.mux.HandleFunc("GET /api/files/{sha256}", s.handleGetFile)
	s.mux.HandleFunc("DELETE /api/files/{sha256}", s.handleDeleteFile)
	s.mux.HandleFunc("GET /api/files/{sha256}/download", s.handleDownloadFile)

	// Serve static files (web UI)
	s.mux.HandleFunc("/", s.handleStatic)
}

// ListenAndServe starts the HTTP server
func (s *Server) ListenAndServe(addr string) error {
	return http.ListenAndServe(addr, s.mux)
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

	http.ServeFile(w, r, filePath)
}

// handleListFiles returns all files (from Blossom)
func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	// For now, return empty list - we'll add metadata support later
	// In the future, this will query Nostr relay for file metadata events
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"files":[]}`)
}

// handleUploadFile handles file uploads
func (s *Server) handleUploadFile(w http.ResponseWriter, r *http.Request) {
	// Parse multipart form
	if err := r.ParseMultipartForm(100 << 20); err != nil { // 100MB max
		http.Error(w, "Failed to parse form", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
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
		log.Printf("Failed to upload to Blossom: %v", err)
		http.Error(w, "Upload failed", http.StatusInternalServerError)
		return
	}

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

	log.Printf("File uploaded: %s (%s, %d bytes)", header.Filename, result.SHA256[:16], result.Size)
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
		log.Printf("Failed to check file existence: %v", err)
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
		log.Printf("Failed to delete file: %v", err)
		http.Error(w, "Delete failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"status":"deleted"}`)

	log.Printf("File deleted: %s", sha256)
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
		log.Printf("Failed to download file: %v", err)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer body.Close()

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
		log.Printf("Failed to stream file: %v", err)
	}
}
