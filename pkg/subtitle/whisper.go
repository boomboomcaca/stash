package subtitle

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// WhisperClient is a client for the Whisper API
type WhisperClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewWhisperClient creates a new Whisper API client
func NewWhisperClient(baseURL string, timeout time.Duration) *WhisperClient {
	return &WhisperClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// TranscribeResult holds the result of a transcription
type TranscribeResult struct {
	Content  string
	Language string
	Format   string
}

// Transcribe sends an audio file to the Whisper API and returns the transcription
func (c *WhisperClient) Transcribe(ctx context.Context, audioPath string, language string) (*TranscribeResult, error) {
	// Open the audio file
	file, err := os.Open(audioPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open audio file: %w", err)
	}
	defer file.Close()

	// Create multipart form
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Add file field
	part, err := writer.CreateFormFile("file", filepath.Base(audioPath))
	if err != nil {
		return nil, fmt.Errorf("failed to create form file: %w", err)
	}

	if _, err := io.Copy(part, file); err != nil {
		return nil, fmt.Errorf("failed to copy file content: %w", err)
	}

	// Add response_format field
	if err := writer.WriteField("response_format", "srt"); err != nil {
		return nil, fmt.Errorf("failed to write response_format field: %w", err)
	}

	// Add language field if specified
	if language != "" {
		if err := writer.WriteField("language", language); err != nil {
			return nil, fmt.Errorf("failed to write language field: %w", err)
		}
	}

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Build request URL
	transcribeURL, err := url.JoinPath(c.baseURL, "/v1/audio/transcriptions")
	if err != nil {
		return nil, fmt.Errorf("failed to build transcribe URL: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(ctx, "POST", transcribeURL, &buf)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	// Send request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("whisper API returned status %d: %s", resp.StatusCode, string(body))
	}

	return &TranscribeResult{
		Content:  string(body),
		Language: language,
		Format:   "srt",
	}, nil
}

// HealthCheck checks if the Whisper service is available
func (c *WhisperClient) HealthCheck(ctx context.Context) error {
	healthURL, err := url.JoinPath(c.baseURL, "/health")
	if err != nil {
		return fmt.Errorf("failed to build health URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", healthURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("whisper service unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("whisper service returned status %d", resp.StatusCode)
	}

	return nil
}
