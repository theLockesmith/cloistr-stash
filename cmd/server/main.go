package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"git.coldforge.xyz/coldforge/coldforge-drive/internal/blossom"
	"git.coldforge.xyz/coldforge/coldforge-drive/internal/config"
	"git.coldforge.xyz/coldforge/coldforge-drive/internal/metadata"
	"git.coldforge.xyz/coldforge/coldforge-drive/internal/server"
	"github.com/joho/godotenv"
)

func main() {
	// Initialize structured logger with JSON output to stdout
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Load environment variables from .env file if it exists
	_ = godotenv.Load()

	// Define command-line flags
	configPath := flag.String("config", "config.yml", "Path to configuration file")
	webDir := flag.String("web", "web", "Path to web UI directory")
	flag.Parse()

	// Load configuration
	cfg, err := config.Load(*configPath)
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
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
		logger.Warn("web directory not found", "path", webPath)
	}

	// Initialize Blossom client
	blossomClient := blossom.NewClient(cfg.Blossom.URL)

	// Check Blossom server health
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := blossomClient.Health(ctx); err != nil {
		logger.Warn("cannot reach Blossom server",
			"url", cfg.Blossom.URL,
			"error", err,
		)
		logger.Warn("file uploads will fail until Blossom is available")
	} else {
		logger.Info("connected to Blossom server", "url", cfg.Blossom.URL)
	}

	// Initialize metadata store (connects to Nostr relay)
	var metadataStore *metadata.Store
	if cfg.Relay.URL != "" {
		metadataStore = metadata.NewStore(cfg.Relay.URL, logger)
		relayCtx, relayCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer relayCancel()
		if err := metadataStore.Connect(relayCtx); err != nil {
			logger.Warn("cannot connect to relay",
				"url", cfg.Relay.URL,
				"error", err,
			)
			logger.Warn("file metadata will not be persisted")
			metadataStore = nil
		} else {
			logger.Info("connected to relay", "url", cfg.Relay.URL)
		}
	}

	// Create HTTP server
	srv := server.New(cfg, blossomClient, metadataStore, webPath, logger)

	// Start server
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	logger.Info("starting Drive server", "address", addr)
	logger.Info("web UI available", "url", fmt.Sprintf("http://%s", addr))
	if err := srv.ListenAndServe(addr); err != nil {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}
