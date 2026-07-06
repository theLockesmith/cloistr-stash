package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config represents the application configuration
type Config struct {
	Server    ServerConfig    `yaml:"server"`
	Blossom   BlossomConfig   `yaml:"blossom"`
	Relay     RelayConfig     `yaml:"relay"`
	Auth      AuthConfig      `yaml:"auth"`
	Quota     QuotaConfig     `yaml:"quota"`
	RateLimit RateLimitConfig `yaml:"rate_limit"`
	Platform  PlatformConfig  `yaml:"platform"`
}

// AuthConfig represents authentication and authorization configuration
type AuthConfig struct {
	WhitelistFile string   `yaml:"whitelist_file"` // Path to file with one pubkey per line
	Pubkeys       []string `yaml:"pubkeys"`        // Inline list of allowed pubkeys
	// SignerURL is the Cloistr signer (IdP) base URL. When set, the .cloistr.xyz
	// session cookie (or a Bearer signer JWT) is accepted as an alternative to a
	// Blossom Nostr-event auth header — unified-auth slice 3 convergence.
	SignerURL string `yaml:"signer_url"`
}

// ServerConfig represents HTTP server configuration
type ServerConfig struct {
	Host      string `yaml:"host"`
	Port      int    `yaml:"port"`
	PublicURL string `yaml:"public_url"`
}

// BlossomConfig represents the Blossom backend configuration
type BlossomConfig struct {
	URL       string `yaml:"url"`        // Internal URL for server-to-server communication
	PublicURL string `yaml:"public_url"` // Public URL returned to clients
}

// RelayConfig represents Nostr relay configuration for metadata
type RelayConfig struct {
	URL string `yaml:"url"`
}

// QuotaConfig represents storage quota configuration
type QuotaConfig struct {
	Enabled      bool             `yaml:"enabled"`       // Enable quota enforcement
	DefaultLimit int64            `yaml:"default_limit"` // Default quota in bytes (0 = unlimited)
	UserLimits   map[string]int64 `yaml:"user_limits"`   // Per-user quota overrides (pubkey -> bytes)
	DataFile     string           `yaml:"data_file"`     // Path to quota data file for persistence
}

// RateLimitConfig represents rate limiting configuration
type RateLimitConfig struct {
	Enabled           bool `yaml:"enabled"`             // Enable rate limiting
	RequestsPerMinute int  `yaml:"requests_per_minute"` // General API requests per minute
	BurstSize         int  `yaml:"burst_size"`          // Max burst size
	UploadsPerMinute  int  `yaml:"uploads_per_minute"`  // Upload requests per minute
}

// PlatformConfig represents cloistr platform integration configuration
type PlatformConfig struct {
	Enabled     bool   `yaml:"enabled"`      // Enable platform ACL (false = standalone mode)
	DatabaseURL string `yaml:"database_url"` // PostgreSQL connection string for platform DB
	ServiceID   string `yaml:"service_id"`   // Service identifier (default: "drive")
}

// Load loads configuration from a YAML file with environment variable overrides
func Load(path string) (*Config, error) {
	// Default configuration
	cfg := &Config{
		Server: ServerConfig{
			Host:      "0.0.0.0",
			Port:      8080,
			PublicURL: "http://localhost:8080",
		},
		Blossom: BlossomConfig{
			URL: "http://localhost:8085",
		},
		Relay: RelayConfig{
			URL: "wss://relay.damus.io",
		},
	}

	// Try to load from file if it exists
	if _, err := os.Stat(path); err == nil {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("failed to read config file: %w", err)
		}

		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("failed to parse config: %w", err)
		}
	}

	// Override with environment variables
	if host := os.Getenv("DRIVE_HOST"); host != "" {
		cfg.Server.Host = host
	}
	if port := os.Getenv("DRIVE_PORT"); port != "" {
		p, err := strconv.Atoi(port)
		if err == nil {
			cfg.Server.Port = p
		}
	}
	if publicURL := os.Getenv("DRIVE_PUBLIC_URL"); publicURL != "" {
		cfg.Server.PublicURL = publicURL
	}
	if blossomURL := os.Getenv("DRIVE_BLOSSOM_URL"); blossomURL != "" {
		cfg.Blossom.URL = blossomURL
	}
	if blossomPublicURL := os.Getenv("DRIVE_BLOSSOM_PUBLIC_URL"); blossomPublicURL != "" {
		cfg.Blossom.PublicURL = blossomPublicURL
	}
	if relayURL := os.Getenv("DRIVE_RELAY_URL"); relayURL != "" {
		cfg.Relay.URL = relayURL
	}

	// Auth configuration from environment
	if whitelistFile := os.Getenv("DRIVE_WHITELIST_FILE"); whitelistFile != "" {
		cfg.Auth.WhitelistFile = whitelistFile
	}
	if signerURL := os.Getenv("DRIVE_SIGNER_URL"); signerURL != "" {
		cfg.Auth.SignerURL = signerURL
	}
	if whitelist := os.Getenv("DRIVE_WHITELIST"); whitelist != "" {
		// Comma-separated pubkeys
		for _, pk := range strings.Split(whitelist, ",") {
			pk = strings.TrimSpace(pk)
			if pk != "" {
				cfg.Auth.Pubkeys = append(cfg.Auth.Pubkeys, pk)
			}
		}
	}

	// Quota configuration from environment
	if quotaEnabled := os.Getenv("DRIVE_QUOTA_ENABLED"); quotaEnabled == "true" || quotaEnabled == "1" {
		cfg.Quota.Enabled = true
	}
	if quotaDefault := os.Getenv("DRIVE_QUOTA_DEFAULT"); quotaDefault != "" {
		limit, err := strconv.ParseInt(quotaDefault, 10, 64)
		if err == nil {
			cfg.Quota.DefaultLimit = limit
		}
	}
	if quotaDataFile := os.Getenv("DRIVE_QUOTA_DATA_FILE"); quotaDataFile != "" {
		cfg.Quota.DataFile = quotaDataFile
	}

	// Rate limiting configuration from environment
	if rlEnabled := os.Getenv("DRIVE_RATELIMIT_ENABLED"); rlEnabled == "true" || rlEnabled == "1" {
		cfg.RateLimit.Enabled = true
	}
	if rlRequests := os.Getenv("DRIVE_RATELIMIT_REQUESTS"); rlRequests != "" {
		val, err := strconv.Atoi(rlRequests)
		if err == nil {
			cfg.RateLimit.RequestsPerMinute = val
		}
	}
	if rlBurst := os.Getenv("DRIVE_RATELIMIT_BURST"); rlBurst != "" {
		val, err := strconv.Atoi(rlBurst)
		if err == nil {
			cfg.RateLimit.BurstSize = val
		}
	}
	if rlUploads := os.Getenv("DRIVE_RATELIMIT_UPLOADS"); rlUploads != "" {
		val, err := strconv.Atoi(rlUploads)
		if err == nil {
			cfg.RateLimit.UploadsPerMinute = val
		}
	}

	// Platform configuration from environment
	if platformEnabled := os.Getenv("DRIVE_PLATFORM_ENABLED"); platformEnabled == "true" || platformEnabled == "1" {
		cfg.Platform.Enabled = true
	}
	if platformDB := os.Getenv("DRIVE_PLATFORM_DATABASE_URL"); platformDB != "" {
		cfg.Platform.DatabaseURL = platformDB
	}
	if platformService := os.Getenv("DRIVE_PLATFORM_SERVICE_ID"); platformService != "" {
		cfg.Platform.ServiceID = platformService
	}
	// Default service ID
	if cfg.Platform.ServiceID == "" {
		cfg.Platform.ServiceID = "drive"
	}

	return cfg, nil
}
