package platform

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	_ "github.com/lib/pq"
)

// Client provides access to the cloistr platform for ACL checks
type Client struct {
	db        *sql.DB
	serviceID string
	logger    *slog.Logger
}

// Config holds platform client configuration
type Config struct {
	DatabaseURL string // PostgreSQL connection string
	ServiceID   string // Service identifier (e.g., "drive")
}

// NewClient creates a new platform client
func NewClient(cfg Config, logger *slog.Logger) (*Client, error) {
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("platform database URL is required")
	}
	if cfg.ServiceID == "" {
		cfg.ServiceID = "drive"
	}

	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open platform database: %w", err)
	}

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to connect to platform database: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)

	return &Client{
		db:        db,
		serviceID: cfg.ServiceID,
		logger:    logger,
	}, nil
}

// HasAccess checks if a pubkey has access to this service
func (c *Client) HasAccess(ctx context.Context, pubkey string) (bool, error) {
	// Query the platform for service access
	// Join users and user_service_access tables
	var hasAccess bool
	err := c.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM user_service_access usa
			JOIN services s ON usa.service_id = s.id
			JOIN users u ON usa.pubkey = u.pubkey
			WHERE usa.pubkey = $1
			  AND s.slug = $2
			  AND usa.enabled = TRUE
			  AND u.enabled = TRUE
		)`, pubkey, c.serviceID).Scan(&hasAccess)

	if err != nil {
		c.logger.Error("platform access check failed",
			"error", err,
			"pubkey", truncate(pubkey, 16),
			"service", c.serviceID,
		)
		return false, fmt.Errorf("access check failed: %w", err)
	}

	if !hasAccess {
		c.logger.Debug("platform access denied",
			"pubkey", truncate(pubkey, 16),
			"service", c.serviceID,
		)
	}

	return hasAccess, nil
}

// EnsureUser creates a platform user record if it doesn't exist
// Returns true if user was created, false if already exists
func (c *Client) EnsureUser(ctx context.Context, pubkey string) (bool, error) {
	result, err := c.db.ExecContext(ctx, `
		INSERT INTO users (pubkey, enabled, created_at, updated_at)
		VALUES ($1, TRUE, NOW(), NOW())
		ON CONFLICT (pubkey) DO NOTHING`, pubkey)
	if err != nil {
		return false, fmt.Errorf("failed to ensure user: %w", err)
	}

	rows, _ := result.RowsAffected()
	return rows > 0, nil
}

// Close closes the database connection
func (c *Client) Close() error {
	if c.db != nil {
		return c.db.Close()
	}
	return nil
}

// truncate safely truncates a string for logging
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
