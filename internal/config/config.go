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
	Server  ServerConfig  `yaml:"server"`
	Blossom BlossomConfig `yaml:"blossom"`
	Relay   RelayConfig   `yaml:"relay"`
	Auth    AuthConfig    `yaml:"auth"`
}

// AuthConfig represents authentication and authorization configuration
type AuthConfig struct {
	WhitelistFile string   `yaml:"whitelist_file"` // Path to file with one pubkey per line
	Pubkeys       []string `yaml:"pubkeys"`        // Inline list of allowed pubkeys
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
	if whitelist := os.Getenv("DRIVE_WHITELIST"); whitelist != "" {
		// Comma-separated pubkeys
		for _, pk := range strings.Split(whitelist, ",") {
			pk = strings.TrimSpace(pk)
			if pk != "" {
				cfg.Auth.Pubkeys = append(cfg.Auth.Pubkeys, pk)
			}
		}
	}

	return cfg, nil
}
