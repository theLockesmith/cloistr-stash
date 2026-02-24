package ratelimit

import (
	"net/http"
	"sync"
	"time"
)

// Limiter implements a token bucket rate limiter
type Limiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	config   Config
	stopChan chan struct{}
}

// Config defines rate limiting parameters
type Config struct {
	// Requests per window
	RequestsPerMinute int `yaml:"requests_per_minute"`
	// Burst size (max tokens)
	BurstSize int `yaml:"burst_size"`
	// Upload specific limits
	UploadsPerMinute int `yaml:"uploads_per_minute"`
	// Cleanup interval for old buckets
	CleanupInterval time.Duration `yaml:"cleanup_interval"`
}

// bucket represents a token bucket for a single client
type bucket struct {
	tokens     float64
	lastUpdate time.Time
	rate       float64 // tokens per second
	maxTokens  float64
}

// DefaultConfig returns sensible default rate limiting settings
func DefaultConfig() Config {
	return Config{
		RequestsPerMinute: 120,  // 2 requests per second average
		BurstSize:         30,   // Allow short bursts
		UploadsPerMinute:  10,   // More restrictive for uploads
		CleanupInterval:   5 * time.Minute,
	}
}

// NewLimiter creates a new rate limiter with the given configuration
func NewLimiter(cfg Config) *Limiter {
	if cfg.RequestsPerMinute <= 0 {
		cfg.RequestsPerMinute = DefaultConfig().RequestsPerMinute
	}
	if cfg.BurstSize <= 0 {
		cfg.BurstSize = DefaultConfig().BurstSize
	}
	if cfg.UploadsPerMinute <= 0 {
		cfg.UploadsPerMinute = DefaultConfig().UploadsPerMinute
	}
	if cfg.CleanupInterval <= 0 {
		cfg.CleanupInterval = DefaultConfig().CleanupInterval
	}

	l := &Limiter{
		buckets:  make(map[string]*bucket),
		config:   cfg,
		stopChan: make(chan struct{}),
	}

	// Start cleanup goroutine
	go l.cleanup()

	return l
}

// Allow checks if a request should be allowed for the given key
func (l *Limiter) Allow(key string) bool {
	return l.allowN(key, 1, float64(l.config.RequestsPerMinute)/60.0, float64(l.config.BurstSize))
}

// AllowUpload checks if an upload should be allowed (stricter limits)
func (l *Limiter) AllowUpload(key string) bool {
	uploadKey := "upload:" + key
	return l.allowN(uploadKey, 1, float64(l.config.UploadsPerMinute)/60.0, float64(l.config.BurstSize/3))
}

// allowN checks if n tokens can be consumed
func (l *Limiter) allowN(key string, n float64, rate float64, maxTokens float64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()

	b, exists := l.buckets[key]
	if !exists {
		// Create new bucket with full tokens
		l.buckets[key] = &bucket{
			tokens:     maxTokens - n,
			lastUpdate: now,
			rate:       rate,
			maxTokens:  maxTokens,
		}
		return true
	}

	// Refill tokens based on time elapsed
	elapsed := now.Sub(b.lastUpdate).Seconds()
	b.tokens += elapsed * b.rate
	if b.tokens > b.maxTokens {
		b.tokens = b.maxTokens
	}
	b.lastUpdate = now

	// Check if we have enough tokens
	if b.tokens >= n {
		b.tokens -= n
		return true
	}

	return false
}

// Middleware returns an HTTP middleware that applies rate limiting
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Use IP address or X-Forwarded-For as the key
		key := l.getClientKey(r)

		if !l.Allow(key) {
			w.Header().Set("Retry-After", "60")
			w.Header().Set("X-RateLimit-Limit", string(rune(l.config.RequestsPerMinute)))
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// UploadMiddleware returns an HTTP middleware for upload rate limiting
func (l *Limiter) UploadMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := l.getClientKey(r)

		if !l.AllowUpload(key) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "Upload rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// getClientKey extracts the client identifier from the request
func (l *Limiter) getClientKey(r *http.Request) string {
	// Check X-Forwarded-For for proxied requests
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}

	// Check X-Real-IP
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}

	// Fall back to RemoteAddr
	return r.RemoteAddr
}

// cleanup periodically removes old buckets
func (l *Limiter) cleanup() {
	ticker := time.NewTicker(l.config.CleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			l.mu.Lock()
			now := time.Now()
			for key, b := range l.buckets {
				// Remove buckets that haven't been accessed in a while
				if now.Sub(b.lastUpdate) > l.config.CleanupInterval*2 {
					delete(l.buckets, key)
				}
			}
			l.mu.Unlock()
		case <-l.stopChan:
			return
		}
	}
}

// Stop stops the cleanup goroutine
func (l *Limiter) Stop() {
	close(l.stopChan)
}

// Stats returns current limiter statistics
func (l *Limiter) Stats() map[string]interface{} {
	l.mu.Lock()
	defer l.mu.Unlock()

	return map[string]interface{}{
		"active_buckets":      len(l.buckets),
		"requests_per_minute": l.config.RequestsPerMinute,
		"burst_size":          l.config.BurstSize,
		"uploads_per_minute":  l.config.UploadsPerMinute,
	}
}
