package blossom

// BlossomError represents an error response from the Blossom protocol
type BlossomError struct {
	Status int    `json:"status"`
	Error  string `json:"error"`
}

// UploadRequest represents a file upload request
type UploadRequest struct {
	SHA256    string
	Filename  string
	MimeType  string
	AuthEvent string // Serialized Nostr event
}

// UploadResponse represents a successful upload response
type UploadResponse struct {
	URL string `json:"url"`
}

// ServerInfo represents information about the Blossom server
type ServerInfo struct {
	BlossomVersion string            `json:"blossom_version"`
	SupportedMimes []string          `json:"supported_mimes"`
	MaxUploadSize  int64             `json:"max_upload_size"`
	Features       map[string]string `json:"features"`
}

// BlossomTag represents a tag in a Nostr event referencing a file
type BlossomTag struct {
	Name  string // "url", "x", "m", etc.
	Value string
}
