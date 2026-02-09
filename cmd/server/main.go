package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"git.coldforge.xyz/coldforge/coldforge-drive/internal/blossom"
	"git.coldforge.xyz/coldforge/coldforge-drive/internal/config"
	"git.coldforge.xyz/coldforge/coldforge-drive/internal/server"
	"github.com/joho/godotenv"
)

func main() {
	// Load environment variables from .env file if it exists
	_ = godotenv.Load()

	// Define command-line flags
	configPath := flag.String("config", "config.yml", "Path to configuration file")
	webDir := flag.String("web", "web", "Path to web UI directory")
	flag.Parse()

	// Load configuration
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Resolve web directory path
	webPath := *webDir
	if !filepath.IsAbs(webPath) {
		// Try to find web directory relative to executable
		execPath, err := os.Executable()
		if err == nil {
			execDir := filepath.Dir(execPath)
			candidate := filepath.Join(execDir, webPath)
			if _, err := os.Stat(candidate); err == nil {
				webPath = candidate
			}
		}
	}

	// Verify web directory exists
	if _, err := os.Stat(webPath); os.IsNotExist(err) {
		log.Printf("Warning: Web directory not found at %s", webPath)
	}

	// Initialize Blossom client
	blossomClient := blossom.NewClient(cfg.Blossom.URL)

	// Check Blossom server health
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := blossomClient.Health(ctx); err != nil {
		log.Printf("Warning: Cannot reach Blossom server at %s: %v", cfg.Blossom.URL, err)
		log.Printf("File uploads will fail until Blossom is available")
	} else {
		log.Printf("Connected to Blossom server at %s", cfg.Blossom.URL)
	}

	// Create HTTP server
	srv := server.New(cfg, blossomClient, webPath)

	// Start server
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	log.Printf("Starting Drive server on %s", addr)
	log.Printf("Web UI available at http://%s", addr)
	if err := srv.ListenAndServe(addr); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
