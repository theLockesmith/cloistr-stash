package blossom

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Client is an HTTP client for communicating with a Blossom server
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// UploadResult contains the result of a successful upload
type UploadResult struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// FileInfo contains metadata about a file
type FileInfo struct {
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	MimeType string `json:"mime_type,omitempty"`
}

// NewClient creates a new Blossom client
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			// No global timeout - rely on context cancellation for large uploads
			// Individual operations can set their own timeouts via context
			Timeout: 0,
		},
	}
}

// Upload sends a file to the Blossom server
func (c *Client) Upload(ctx context.Context, reader io.Reader, contentType string, authHeader string) (*UploadResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+"/upload", reader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	} else {
		req.Header.Set("Content-Type", "application/octet-stream")
	}

	// Add Blossom auth header if provided
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to upload: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("upload failed with status %d: %s", resp.StatusCode, string(body))
	}

	var result UploadResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// Download retrieves a file from the Blossom server by its SHA256 hash
func (c *Client) Download(ctx context.Context, sha256 string) (io.ReadCloser, *FileInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/"+sha256, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to download: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		_ = resp.Body.Close()
		return nil, nil, fmt.Errorf("file not found: %s", sha256)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return nil, nil, fmt.Errorf("download failed with status %d: %s", resp.StatusCode, string(body))
	}

	info := &FileInfo{
		SHA256:   sha256,
		Size:     resp.ContentLength,
		MimeType: resp.Header.Get("Content-Type"),
	}

	return resp.Body, info, nil
}

// Exists checks if a file exists on the Blossom server
func (c *Client) Exists(ctx context.Context, sha256 string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, c.baseURL+"/"+sha256, nil)
	if err != nil {
		return false, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("failed to check existence: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode == http.StatusOK, nil
}

// Delete removes a file from the Blossom server
func (c *Client) Delete(ctx context.Context, sha256 string, authHeader string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.baseURL+"/"+sha256, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Add Blossom auth header if provided
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("delete failed with status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// Health checks if the Blossom server is healthy
func (c *Client) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/.well-known/health", nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("blossom server unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("blossom server unhealthy: status %d", resp.StatusCode)
	}

	return nil
}

// Info retrieves server information from the Blossom server
func (c *Client) Info(ctx context.Context) (*ServerInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/info", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get info: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get info: status %d: %s", resp.StatusCode, string(body))
	}

	var info ServerInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &info, nil
}
