package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	// Load with non-existent file should use defaults
	cfg, err := Load("/nonexistent/config.yml")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	// Check defaults
	if cfg.Server.Host != "0.0.0.0" {
		t.Errorf("Expected default host 0.0.0.0, got %s", cfg.Server.Host)
	}
	if cfg.Server.Port != 8080 {
		t.Errorf("Expected default port 8080, got %d", cfg.Server.Port)
	}
	if cfg.Blossom.URL != "http://localhost:8085" {
		t.Errorf("Expected default blossom URL, got %s", cfg.Blossom.URL)
	}
	if cfg.Relay.URL != "wss://relay.damus.io" {
		t.Errorf("Expected default relay URL, got %s", cfg.Relay.URL)
	}
}

func TestLoadFromFile(t *testing.T) {
	// Create temp config file
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.yml")

	configContent := `
server:
  host: "127.0.0.1"
  port: 9000
  public_url: "https://drive.example.com"
blossom:
  url: "http://blossom:3000"
  public_url: "https://files.example.com"
relay:
  url: "wss://relay.example.com"
auth:
  pubkeys:
    - "abc123"
    - "def456"
`
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatalf("Failed to write config file: %v", err)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	// Check loaded values
	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("Expected host 127.0.0.1, got %s", cfg.Server.Host)
	}
	if cfg.Server.Port != 9000 {
		t.Errorf("Expected port 9000, got %d", cfg.Server.Port)
	}
	if cfg.Server.PublicURL != "https://drive.example.com" {
		t.Errorf("Expected public URL https://drive.example.com, got %s", cfg.Server.PublicURL)
	}
	if cfg.Blossom.URL != "http://blossom:3000" {
		t.Errorf("Expected blossom URL http://blossom:3000, got %s", cfg.Blossom.URL)
	}
	if cfg.Blossom.PublicURL != "https://files.example.com" {
		t.Errorf("Expected blossom public URL https://files.example.com, got %s", cfg.Blossom.PublicURL)
	}
	if cfg.Relay.URL != "wss://relay.example.com" {
		t.Errorf("Expected relay URL wss://relay.example.com, got %s", cfg.Relay.URL)
	}
	if len(cfg.Auth.Pubkeys) != 2 {
		t.Errorf("Expected 2 pubkeys, got %d", len(cfg.Auth.Pubkeys))
	}
}

func TestLoadEnvOverrides(t *testing.T) {
	// Set environment variables
	os.Setenv("DRIVE_HOST", "192.168.1.1")
	os.Setenv("DRIVE_PORT", "3000")
	os.Setenv("DRIVE_PUBLIC_URL", "https://custom.example.com")
	os.Setenv("DRIVE_BLOSSOM_URL", "http://custom-blossom:8000")
	os.Setenv("DRIVE_RELAY_URL", "wss://custom-relay.example.com")
	os.Setenv("DRIVE_WHITELIST", "pubkey1,pubkey2,pubkey3")
	defer func() {
		os.Unsetenv("DRIVE_HOST")
		os.Unsetenv("DRIVE_PORT")
		os.Unsetenv("DRIVE_PUBLIC_URL")
		os.Unsetenv("DRIVE_BLOSSOM_URL")
		os.Unsetenv("DRIVE_RELAY_URL")
		os.Unsetenv("DRIVE_WHITELIST")
	}()

	cfg, err := Load("/nonexistent/config.yml")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	// Check env overrides
	if cfg.Server.Host != "192.168.1.1" {
		t.Errorf("Expected host 192.168.1.1, got %s", cfg.Server.Host)
	}
	if cfg.Server.Port != 3000 {
		t.Errorf("Expected port 3000, got %d", cfg.Server.Port)
	}
	if cfg.Server.PublicURL != "https://custom.example.com" {
		t.Errorf("Expected public URL https://custom.example.com, got %s", cfg.Server.PublicURL)
	}
	if cfg.Blossom.URL != "http://custom-blossom:8000" {
		t.Errorf("Expected blossom URL http://custom-blossom:8000, got %s", cfg.Blossom.URL)
	}
	if cfg.Relay.URL != "wss://custom-relay.example.com" {
		t.Errorf("Expected relay URL wss://custom-relay.example.com, got %s", cfg.Relay.URL)
	}
	if len(cfg.Auth.Pubkeys) != 3 {
		t.Errorf("Expected 3 pubkeys from whitelist, got %d", len(cfg.Auth.Pubkeys))
	}
}

func TestLoadInvalidYAML(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.yml")

	// Write invalid YAML
	if err := os.WriteFile(configPath, []byte("invalid: yaml: content:"), 0644); err != nil {
		t.Fatalf("Failed to write config file: %v", err)
	}

	_, err := Load(configPath)
	if err == nil {
		t.Error("Expected error for invalid YAML, got nil")
	}
}

func TestWhitelistParsing(t *testing.T) {
	os.Setenv("DRIVE_WHITELIST", "  pk1  , pk2,pk3  ,  ")
	defer os.Unsetenv("DRIVE_WHITELIST")

	cfg, err := Load("/nonexistent/config.yml")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	expected := []string{"pk1", "pk2", "pk3"}
	if len(cfg.Auth.Pubkeys) != len(expected) {
		t.Errorf("Expected %d pubkeys, got %d", len(expected), len(cfg.Auth.Pubkeys))
	}
	for i, pk := range expected {
		if i < len(cfg.Auth.Pubkeys) && cfg.Auth.Pubkeys[i] != pk {
			t.Errorf("Expected pubkey %s at index %d, got %s", pk, i, cfg.Auth.Pubkeys[i])
		}
	}
}
