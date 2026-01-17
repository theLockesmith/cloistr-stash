package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/coldforge/coldforge-files/internal/config"
	"github.com/coldforge/coldforge-files/internal/server"
	"github.com/coldforge/coldforge-files/internal/storage"
	"github.com/joho/godotenv"
)

func main() {
	// Load environment variables from .env file if it exists
	_ = godotenv.Load()

	// Define command-line flags
	configPath := flag.String("config", "config.yml", "Path to configuration file")
	flag.Parse()

	// Load configuration
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize storage backend
	var store storage.Backend
	switch cfg.Storage.Type {
	case "filesystem":
		store, err = storage.NewFilesystem(cfg.Storage.Filesystem.Path)
		if err != nil {
			log.Fatalf("Failed to initialize filesystem storage: %v", err)
		}
	default:
		log.Fatalf("Unknown storage type: %s", cfg.Storage.Type)
	}

	// Create HTTP server
	srv := server.New(cfg, store)

	// Start server
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	log.Printf("Starting Blossom server on %s", addr)
	if err := srv.ListenAndServe(addr); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
