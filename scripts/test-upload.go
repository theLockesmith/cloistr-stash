// +build ignore

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func main() {
	// Configuration
	driveURL := getEnv("DRIVE_URL", "http://localhost:8091")
	blossomURL := getEnv("BLOSSOM_URL", "http://localhost:8085")
	privateKey := os.Getenv("NOSTR_PRIVATE_KEY")

	// Generate a new key if not provided
	if privateKey == "" {
		privateKey = nostr.GeneratePrivateKey()
		fmt.Printf("Generated new private key: %s\n", privateKey)
	}

	pubkey, err := nostr.GetPublicKey(privateKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to get public key: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Using pubkey: %s\n", pubkey)

	// Test content - minimal valid PNG (1x1 transparent pixel)
	// Blossom sniffs content type so we need actual binary content
	testContent := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimensions
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, // bit depth, color type, etc
		0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, // IDAT chunk
		0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, // compressed data
		0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, //
		0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, // IEND chunk
		0x42, 0x60, 0x82, // IEND CRC
	}
	contentType := "image/png"

	// Calculate SHA256
	hash := sha256.Sum256(testContent)
	fileHash := hex.EncodeToString(hash[:])
	fmt.Printf("File SHA256: %s\n", fileHash)
	fmt.Printf("File size: %d bytes\n", len(testContent))

	// Create Blossom auth event (kind 24242)
	authEvent := nostr.Event{
		Kind:      24242,
		PubKey:    pubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Tags: nostr.Tags{
			{"t", "upload"},
			{"x", fileHash},
			{"expiration", fmt.Sprintf("%d", time.Now().Add(5*time.Minute).Unix())},
		},
		Content: "Upload file",
	}

	// Sign the event
	if err := authEvent.Sign(privateKey); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to sign event: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Auth event ID: %s\n", authEvent.ID)

	// Auth header will be base64-encoded JSON of the signed event

	// Try direct upload to Blossom first
	fmt.Printf("\n--- Testing direct Blossom upload ---\n")
	fmt.Printf("URL: %s/upload\n", blossomURL)

	req, err := http.NewRequest(http.MethodPut, blossomURL+"/upload", bytes.NewReader(testContent))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create request: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Nostr "+base64EncodeJSON(authEvent))

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Request failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	fmt.Printf("Status: %d\n", resp.StatusCode)
	fmt.Printf("Response: %s\n", string(body))

	if resp.StatusCode == http.StatusOK {
		fmt.Printf("\nUpload successful!\n")

		// Try to download the file
		fmt.Printf("\n--- Testing download ---\n")
		downloadResp, err := http.Get(blossomURL + "/" + fileHash)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Download failed: %v\n", err)
		} else {
			defer downloadResp.Body.Close()
			downloadBody, _ := io.ReadAll(downloadResp.Body)
			fmt.Printf("Download status: %d\n", downloadResp.StatusCode)
			fmt.Printf("Downloaded content: %s\n", string(downloadBody))
		}
	}

	// Also test via Drive proxy
	fmt.Printf("\n--- Testing Drive proxy upload ---\n")
	fmt.Printf("URL: %s/api/files\n", driveURL)

	// For Drive, we use multipart form
	testDriveUpload(driveURL, testContent, contentType, authEvent, privateKey)
}

func testDriveUpload(driveURL string, content []byte, contentType string, authEvent nostr.Event, privateKey string) {
	// Create multipart form body
	boundary := "----TestBoundary" + fmt.Sprintf("%d", time.Now().UnixNano())
	var body bytes.Buffer

	body.WriteString("--" + boundary + "\r\n")
	body.WriteString("Content-Disposition: form-data; name=\"file\"; filename=\"test.png\"\r\n")
	body.WriteString("Content-Type: " + contentType + "\r\n\r\n")
	body.Write(content)
	body.WriteString("\r\n--" + boundary + "--\r\n")

	req, err := http.NewRequest(http.MethodPost, driveURL+"/api/files", &body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create request: %v\n", err)
		return
	}
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	req.Header.Set("X-Blossom-Auth", "Nostr "+base64EncodeJSON(authEvent))

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Request failed: %v\n", err)
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	fmt.Printf("Status: %d\n", resp.StatusCode)
	fmt.Printf("Response: %s\n", string(respBody))
}

func base64EncodeJSON(event nostr.Event) string {
	eventJSON, _ := json.Marshal(event)
	return b64Encode(eventJSON)
}

func b64Encode(data []byte) string {
	const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	result := make([]byte, 0, (len(data)+2)/3*4)

	for i := 0; i < len(data); i += 3 {
		var n uint32
		remaining := len(data) - i

		n = uint32(data[i]) << 16
		if remaining > 1 {
			n |= uint32(data[i+1]) << 8
		}
		if remaining > 2 {
			n |= uint32(data[i+2])
		}

		result = append(result, base64Chars[(n>>18)&0x3F])
		result = append(result, base64Chars[(n>>12)&0x3F])
		if remaining > 1 {
			result = append(result, base64Chars[(n>>6)&0x3F])
		} else {
			result = append(result, '=')
		}
		if remaining > 2 {
			result = append(result, base64Chars[n&0x3F])
		} else {
			result = append(result, '=')
		}
	}

	return string(result)
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
