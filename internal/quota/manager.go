package quota

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"git.coldforge.xyz/coldforge/cloistr-drive/internal/config"
)

// Manager handles storage quota tracking and enforcement
type Manager struct {
	enabled      bool
	defaultLimit int64
	userLimits   map[string]int64
	dataFile     string
	logger       *slog.Logger

	mu    sync.RWMutex
	usage map[string]int64 // pubkey -> bytes used
}

// Usage represents quota usage information for a user
type Usage struct {
	Pubkey    string `json:"pubkey"`
	Used      int64  `json:"used"`       // Bytes currently used
	Limit     int64  `json:"limit"`      // Quota limit in bytes (0 = unlimited)
	Available int64  `json:"available"`  // Bytes available (-1 = unlimited)
	Percent   int    `json:"percent"`    // Percentage used (0 if unlimited)
}

// NewManager creates a new quota manager
func NewManager(cfg config.QuotaConfig, logger *slog.Logger) *Manager {
	m := &Manager{
		enabled:      cfg.Enabled,
		defaultLimit: cfg.DefaultLimit,
		userLimits:   cfg.UserLimits,
		dataFile:     cfg.DataFile,
		logger:       logger,
		usage:        make(map[string]int64),
	}

	// Initialize userLimits map if nil
	if m.userLimits == nil {
		m.userLimits = make(map[string]int64)
	}

	// Load persisted usage data
	if m.dataFile != "" {
		if err := m.load(); err != nil {
			logger.Warn("failed to load quota data", "file", m.dataFile, "error", err)
		}
	}

	return m
}

// IsEnabled returns whether quota enforcement is enabled
func (m *Manager) IsEnabled() bool {
	return m.enabled
}

// GetLimit returns the quota limit for a given pubkey
func (m *Manager) GetLimit(pubkey string) int64 {
	// Check for user-specific limit first
	if limit, ok := m.userLimits[pubkey]; ok {
		return limit
	}
	return m.defaultLimit
}

// GetUsage returns the current usage for a pubkey
func (m *Manager) GetUsage(pubkey string) int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.usage[pubkey]
}

// GetQuotaInfo returns complete quota information for a user
func (m *Manager) GetQuotaInfo(pubkey string) Usage {
	used := m.GetUsage(pubkey)
	limit := m.GetLimit(pubkey)

	info := Usage{
		Pubkey: pubkey,
		Used:   used,
		Limit:  limit,
	}

	if limit <= 0 {
		// Unlimited
		info.Available = -1
		info.Percent = 0
	} else {
		info.Available = limit - used
		if info.Available < 0 {
			info.Available = 0
		}
		info.Percent = int((float64(used) / float64(limit)) * 100)
		if info.Percent > 100 {
			info.Percent = 100
		}
	}

	return info
}

// CheckQuota verifies if a user can upload a file of the given size
// Returns nil if allowed, error if quota would be exceeded
func (m *Manager) CheckQuota(pubkey string, size int64) error {
	if !m.enabled {
		return nil
	}

	limit := m.GetLimit(pubkey)
	if limit <= 0 {
		// Unlimited quota
		return nil
	}

	currentUsage := m.GetUsage(pubkey)
	if currentUsage+size > limit {
		return fmt.Errorf("quota exceeded: current usage %d + upload size %d > limit %d",
			currentUsage, size, limit)
	}

	return nil
}

// AddUsage adds bytes to a user's usage count
func (m *Manager) AddUsage(pubkey string, size int64) {
	m.mu.Lock()
	m.usage[pubkey] += size
	m.mu.Unlock()

	// Persist to disk
	if m.dataFile != "" {
		if err := m.save(); err != nil {
			m.logger.Error("failed to save quota data", "error", err)
		}
	}

	m.logger.Info("quota usage updated",
		"pubkey", pubkey[:min(16, len(pubkey))],
		"added", size,
		"total", m.GetUsage(pubkey),
	)
}

// RemoveUsage removes bytes from a user's usage count
func (m *Manager) RemoveUsage(pubkey string, size int64) {
	m.mu.Lock()
	m.usage[pubkey] -= size
	if m.usage[pubkey] < 0 {
		m.usage[pubkey] = 0
	}
	m.mu.Unlock()

	// Persist to disk
	if m.dataFile != "" {
		if err := m.save(); err != nil {
			m.logger.Error("failed to save quota data", "error", err)
		}
	}

	m.logger.Info("quota usage reduced",
		"pubkey", pubkey[:min(16, len(pubkey))],
		"removed", size,
		"total", m.GetUsage(pubkey),
	)
}

// SetUsage sets the exact usage for a user (used for recalculation)
func (m *Manager) SetUsage(pubkey string, size int64) {
	m.mu.Lock()
	m.usage[pubkey] = size
	m.mu.Unlock()

	if m.dataFile != "" {
		if err := m.save(); err != nil {
			m.logger.Error("failed to save quota data", "error", err)
		}
	}
}

// load reads usage data from disk
func (m *Manager) load() error {
	data, err := os.ReadFile(m.dataFile)
	if os.IsNotExist(err) {
		return nil // File doesn't exist yet, that's fine
	}
	if err != nil {
		return fmt.Errorf("failed to read quota file: %w", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if err := json.Unmarshal(data, &m.usage); err != nil {
		return fmt.Errorf("failed to parse quota file: %w", err)
	}

	m.logger.Info("loaded quota data", "file", m.dataFile, "users", len(m.usage))
	return nil
}

// save writes usage data to disk
func (m *Manager) save() error {
	m.mu.RLock()
	data, err := json.MarshalIndent(m.usage, "", "  ")
	m.mu.RUnlock()

	if err != nil {
		return fmt.Errorf("failed to marshal quota data: %w", err)
	}

	if err := os.WriteFile(m.dataFile, data, 0644); err != nil {
		return fmt.Errorf("failed to write quota file: %w", err)
	}

	return nil
}

// FormatBytes formats bytes as a human-readable string
func FormatBytes(bytes int64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
		TB = GB * 1024
	)

	switch {
	case bytes >= TB:
		return fmt.Sprintf("%.2f TB", float64(bytes)/float64(TB))
	case bytes >= GB:
		return fmt.Sprintf("%.2f GB", float64(bytes)/float64(GB))
	case bytes >= MB:
		return fmt.Sprintf("%.2f MB", float64(bytes)/float64(MB))
	case bytes >= KB:
		return fmt.Sprintf("%.2f KB", float64(bytes)/float64(KB))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}
