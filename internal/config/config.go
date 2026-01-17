package config

import (
	"fmt"
	"os"
	"strconv"

	"gopkg.in/yaml.v3"
)

// Config represents the application configuration
type Config struct {
	Server   ServerConfig   `yaml:"server"`
	Storage  StorageConfig  `yaml:"storage"`
	Auth     AuthConfig     `yaml:"auth"`
	Blossom  BlossomConfig  `yaml:"blossom"`
}

// ServerConfig represents HTTP server configuration
type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

// StorageConfig represents storage backend configuration
type StorageConfig struct {
	Type       string             `yaml:"type"`
	Filesystem FilesystemConfig   `yaml:"filesystem"`
}

// FilesystemConfig represents filesystem storage configuration
type FilesystemConfig struct {
	Path string `yaml:"path"`
}

// AuthConfig represents authentication configuration
type AuthConfig struct {
	RelayURL string `yaml:"relay_url"`
}

// BlossomConfig represents Blossom protocol configuration
type BlossomConfig struct {
	PublicURL string `yaml:"public_url"`
}

// Load loads configuration from a YAML file with environment variable overrides
func Load(path string) (*Config, error) {
	// Default configuration
	cfg := &Config{
		Server: ServerConfig{
			Host: "0.0.0.0",
			Port: 8080,
		},
		Storage: StorageConfig{
			Type: "filesystem",
			Filesystem: FilesystemConfig{
				Path: "./data",
			},
		},
		Auth: AuthConfig{
			RelayURL: "wss://relay.example.com",
		},
		Blossom: BlossomConfig{
			PublicURL: "https://blossom.example.com",
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
	if host := os.Getenv("BLOSSOM_HOST"); host != "" {
		cfg.Server.Host = host
	}
	if port := os.Getenv("BLOSSOM_PORT"); port != "" {
		p, err := strconv.Atoi(port)
		if err == nil {
			cfg.Server.Port = p
		}
	}
	if storagePath := os.Getenv("BLOSSOM_STORAGE_PATH"); storagePath != "" {
		cfg.Storage.Filesystem.Path = storagePath
	}
	if relayURL := os.Getenv("BLOSSOM_RELAY_URL"); relayURL != "" {
		cfg.Auth.RelayURL = relayURL
	}
	if publicURL := os.Getenv("BLOSSOM_PUBLIC_URL"); publicURL != "" {
		cfg.Blossom.PublicURL = publicURL
	}

	return cfg, nil
}
