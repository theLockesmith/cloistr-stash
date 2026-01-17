package server

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/coldforge/coldforge-files/internal/auth"
	"github.com/coldforge/coldforge-files/internal/config"
	"github.com/coldforge/coldforge-files/internal/storage"
)

// Server represents the HTTP server
type Server struct {
	config  *config.Config
	storage storage.Backend
	auth    *auth.NIP46Verifier
	mux     *http.ServeMux
}

// New creates a new HTTP server
func New(cfg *config.Config, store storage.Backend) *Server {
	s := &Server{
		config:  cfg,
		storage: store,
		auth:    auth.NewNIP46Verifier(cfg.Auth.RelayURL),
		mux:     http.NewServeMux(),
	}

	// Register routes
	s.registerRoutes()

	return s
}

// registerRoutes registers all HTTP endpoints
func (s *Server) registerRoutes() {
	// Health check endpoint
	s.mux.HandleFunc("/health", s.handleHealth)

	// Server info endpoint
	s.mux.HandleFunc("/info", s.handleInfo)

	// File operations
	s.mux.HandleFunc("GET /", s.handleFileDownload)
	s.mux.HandleFunc("HEAD /", s.handleFileHead)
	s.mux.HandleFunc("PUT /upload", s.handleFileUpload)
	s.mux.HandleFunc("DELETE /", s.handleFileDelete)
	s.mux.HandleFunc("GET /list/", s.handleListFiles)
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

// handleInfo returns server information
func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	info := fmt.Sprintf(`{
		"blossom_version": "0.1.0",
		"public_url": "%s",
		"max_upload_size": 10737418240,
		"supported_mimes": ["*/*"],
		"features": {
			"nip46": true,
			"content_addressable": true,
			"deduplication": true
		}
	}`, s.config.Blossom.PublicURL)
	fmt.Fprint(w, info)
}

// handleFileDownload handles GET requests to download a file
func (s *Server) handleFileDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract SHA256 from path
	sha256 := strings.TrimPrefix(r.URL.Path, "/")
	if sha256 == "" {
		http.Error(w, "SHA256 hash required", http.StatusBadRequest)
		return
	}

	// Retrieve file
	file, info, err := s.storage.Retrieve(r.Context(), sha256)
	if err != nil {
		log.Printf("Failed to retrieve file %s: %v", sha256, err)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer file.Close()

	// Set response headers
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size))
	if info.MimeType != "" {
		w.Header().Set("Content-Type", info.MimeType)
	}
	w.Header().Set("x-content-sha256", sha256)

	// Stream file
	if _, err := io.Copy(w, file); err != nil {
		log.Printf("Failed to write file: %v", err)
	}
}

// handleFileHead handles HEAD requests to check if a file exists
func (s *Server) handleFileHead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract SHA256 from path
	sha256 := strings.TrimPrefix(r.URL.Path, "/")
	if sha256 == "" {
		http.Error(w, "SHA256 hash required", http.StatusBadRequest)
		return
	}

	// Check if file exists
	exists, err := s.storage.Exists(r.Context(), sha256)
	if err != nil {
		log.Printf("Failed to check file existence: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	if !exists {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Get file size
	size, err := s.storage.GetSize(r.Context(), sha256)
	if err != nil {
		log.Printf("Failed to get file size: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Set response headers
	w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
	w.Header().Set("x-content-sha256", sha256)
	w.WriteHeader(http.StatusOK)
}

// handleFileUpload handles PUT requests to upload a file
func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// TODO: Verify NIP-46 authorization from request header
	// For now, accept uploads without auth (development mode)

	// Store file
	sha256, size, err := s.storage.Store(r.Context(), r.Body)
	if err != nil {
		log.Printf("Failed to store file: %v", err)
		http.Error(w, "Failed to store file", http.StatusInternalServerError)
		return
	}

	// Return success response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	url := fmt.Sprintf("%s/%s", s.config.Blossom.PublicURL, sha256)
	response := fmt.Sprintf(`{"url":"%s","sha256":"%s","size":%d}`, url, sha256, size)
	fmt.Fprint(w, response)

	log.Printf("File uploaded: %s (size: %d bytes)", sha256, size)
}

// handleFileDelete handles DELETE requests to remove a file
func (s *Server) handleFileDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// TODO: Verify NIP-46 authorization from request header
	// For now, accept deletes without auth (development mode)

	// Extract SHA256 from path
	sha256 := strings.TrimPrefix(r.URL.Path, "/")
	if sha256 == "" {
		http.Error(w, "SHA256 hash required", http.StatusBadRequest)
		return
	}

	// Delete file
	err := s.storage.Delete(r.Context(), sha256)
	if err != nil {
		log.Printf("Failed to delete file %s: %v", sha256, err)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"status":"deleted"}`)

	log.Printf("File deleted: %s", sha256)
}

// handleListFiles handles GET requests to list files for a pubkey
func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract pubkey from path
	pubkey := strings.TrimPrefix(r.URL.Path, "/list/")
	if pubkey == "" {
		http.Error(w, "Pubkey required", http.StatusBadRequest)
		return
	}

	// TODO: Verify that requester is the pubkey or has permission to list

	// List files
	files, err := s.storage.List(r.Context(), pubkey)
	if err != nil {
		log.Printf("Failed to list files for %s: %v", pubkey, err)
		http.Error(w, "Failed to list files", http.StatusInternalServerError)
		return
	}

	// Return list as JSON
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"files":[`)
	for i, file := range files {
		if i > 0 {
			fmt.Fprint(w, ",")
		}
		fmt.Fprintf(w, `{"sha256":"%s","size":%d}`, file.SHA256, file.Size)
	}
	fmt.Fprint(w, `]}`)
}
