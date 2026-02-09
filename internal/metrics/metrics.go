package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// RequestsTotal counts total HTTP requests
	RequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "coldforge_drive_requests_total",
			Help: "Total HTTP requests processed",
		},
		[]string{"method", "path", "status"},
	)

	// RequestDuration tracks request latency
	RequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "coldforge_drive_request_duration_seconds",
			Help:    "HTTP request duration in seconds",
			Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		},
		[]string{"method", "path"},
	)

	// ErrorsTotal counts errors by type
	ErrorsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "coldforge_drive_errors_total",
			Help: "Total errors by type",
		},
		[]string{"type"},
	)

	// UploadsTotal counts file uploads
	UploadsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "coldforge_drive_uploads_total",
			Help: "Total file uploads",
		},
		[]string{"status"},
	)

	// UploadBytes tracks bytes uploaded
	UploadBytes = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "coldforge_drive_upload_bytes_total",
			Help: "Total bytes uploaded",
		},
	)

	// DownloadsTotal counts file downloads
	DownloadsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "coldforge_drive_downloads_total",
			Help: "Total file downloads",
		},
		[]string{"status"},
	)

	// ActiveConnections tracks current active connections
	ActiveConnections = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "coldforge_drive_active_connections",
			Help: "Current number of active connections",
		},
	)
)

// Handler returns the Prometheus metrics HTTP handler
func Handler() http.Handler {
	return promhttp.Handler()
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

// Middleware returns HTTP middleware that records metrics
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip metrics endpoint itself
		if r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}

		start := time.Now()
		ActiveConnections.Inc()
		defer ActiveConnections.Dec()

		// Wrap response writer to capture status
		wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}

		// Serve request
		next.ServeHTTP(wrapped, r)

		// Record metrics
		duration := time.Since(start)
		path := normalizePath(r.URL.Path)

		RequestsTotal.WithLabelValues(r.Method, path, strconv.Itoa(wrapped.status)).Inc()
		RequestDuration.WithLabelValues(r.Method, path).Observe(duration.Seconds())

		// Track errors
		if wrapped.status >= 400 {
			if wrapped.status >= 500 {
				ErrorsTotal.WithLabelValues("server_error").Inc()
			} else {
				ErrorsTotal.WithLabelValues("client_error").Inc()
			}
		}
	})
}

// normalizePath normalizes URL paths for metrics labels
// This prevents high cardinality from dynamic path segments
func normalizePath(path string) string {
	// Normalize API paths with dynamic segments
	switch {
	case len(path) > 11 && path[:11] == "/api/files/":
		if len(path) > 20 && path[len(path)-9:] == "/download" {
			return "/api/files/{sha256}/download"
		}
		return "/api/files/{sha256}"
	case path == "/api/files":
		return "/api/files"
	case path == "/health":
		return "/health"
	case path == "/metrics":
		return "/metrics"
	default:
		// Static files - group them
		if len(path) > 4 && path[:4] == "/js/" {
			return "/js/*"
		}
		if len(path) > 5 && path[:5] == "/css/" {
			return "/css/*"
		}
		if path == "/" || path == "/index.html" {
			return "/"
		}
		return "/static"
	}
}

// RecordUpload records an upload metric
func RecordUpload(success bool, bytes int64) {
	status := "success"
	if !success {
		status = "error"
	}
	UploadsTotal.WithLabelValues(status).Inc()
	if success && bytes > 0 {
		UploadBytes.Add(float64(bytes))
	}
}

// RecordDownload records a download metric
func RecordDownload(success bool) {
	status := "success"
	if !success {
		status = "error"
	}
	DownloadsTotal.WithLabelValues(status).Inc()
}
