package subtitle

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/stashapp/stash/pkg/logger"
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

// AsyncTaskResponse represents the response from async task submission
type AsyncTaskResponse struct {
	TaskID string `json:"task_id"`
	Status string `json:"status"`
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// TranscribeResult holds the result of a transcription
type TranscribeResult struct {
	Content  string
	Language string
	Format   string
}

// Transcribe sends an audio file to the Whisper API and returns the transcription
// If translate is true, it will translate non-English audio to English
func (c *WhisperClient) Transcribe(ctx context.Context, audioPath string, language string, translate bool, requestFormat string) (*TranscribeResult, error) {
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
	if requestFormat == "" {
		requestFormat = "srt"
	}
	if err := writer.WriteField("response_format", requestFormat); err != nil {
		return nil, fmt.Errorf("failed to write response_format field: %w", err)
	}

	// Add language field if specified (not used for translation endpoint)
	if language != "" && !translate {
		if err := writer.WriteField("language", language); err != nil {
			return nil, fmt.Errorf("failed to write language field: %w", err)
		}
	}

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Build request URL - use translations endpoint if translate is true
	var endpoint string
	if translate {
		endpoint = "/v1/audio/translations"
	} else {
		endpoint = "/v1/audio/transcriptions"
	}

	requestURL, err := url.JoinPath(c.baseURL, endpoint)
	if err != nil {
		return nil, fmt.Errorf("failed to build request URL: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(ctx, "POST", requestURL, &buf)
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

	resultLang := language
	if translate {
		resultLang = "en"
	}

	return &TranscribeResult{
		Content:  string(body),
		Language: resultLang,
		Format:   requestFormat,
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

// TranscribeAsync sends an audio file to the Whisper API asynchronously
// It submits the task and polls for completion, avoiding long HTTP timeouts
func (c *WhisperClient) TranscribeAsync(ctx context.Context, audioPath string, language string, translate bool, requestFormat string) (*TranscribeResult, error) {
	// Step 1: Submit the task
	taskID, err := c.submitAsyncTask(ctx, audioPath, translate, requestFormat)
	if err != nil {
		// Fallback to sync API if async not available
		logger.Debugf("Async API not available, falling back to sync: %v", err)
		return c.Transcribe(ctx, audioPath, language, translate, requestFormat)
	}

	logger.Infof("Submitted async task %s for %s", taskID, filepath.Base(audioPath))

	// Step 2: Poll for completion (no timeout - wait until done)
	pollInterval := 5 * time.Second

	for {
		select {
		case <-ctx.Done():
			logger.Infof("Whisper task %s cancelled by user, notifying remote server...", taskID)
			// Ping the server to cancel the task using a fresh context
			if cancelErr := c.cancelTask(taskID); cancelErr != nil {
				logger.Warnf("Failed to cancel Whisper task %s on server: %v", taskID, cancelErr)
			}
			return nil, ctx.Err()
		case <-time.After(pollInterval):
			status, result, err := c.getTaskStatus(ctx, taskID)
			if err != nil {
				logger.Warnf("Failed to get task status: %v", err)
				continue
			}

			switch status {
			case "completed":
				resultLang := language
				if translate {
					resultLang = "en"
				}
				if requestFormat == "" {
					requestFormat = "srt"
				}
				return &TranscribeResult{
					Content:  result,
					Language: resultLang,
					Format:   requestFormat,
				}, nil
			case "failed":
				return nil, fmt.Errorf("task failed: %s", result)
			case "pending", "processing":
				logger.Debugf("Task %s status: %s", taskID, status)
				continue
			default:
				logger.Warnf("Unknown task status: %s", status)
				continue
			}
		}
	}
}

// submitAsyncTask submits an async translation task
func (c *WhisperClient) submitAsyncTask(ctx context.Context, audioPath string, translate bool, requestFormat string) (string, error) {
	file, err := os.Open(audioPath)
	if err != nil {
		return "", fmt.Errorf("failed to open audio file: %w", err)
	}
	defer file.Close()

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	part, err := writer.CreateFormFile("file", filepath.Base(audioPath))
	if err != nil {
		return "", fmt.Errorf("failed to create form file: %w", err)
	}

	if _, err := io.Copy(part, file); err != nil {
		return "", fmt.Errorf("failed to copy file content: %w", err)
	}

	if requestFormat == "" {
		requestFormat = "srt"
	}
	if err := writer.WriteField("response_format", requestFormat); err != nil {
		return "", fmt.Errorf("failed to write response_format field: %w", err)
	}

	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Use async endpoint
	var endpoint string
	if translate {
		endpoint = "/v1/async/translations"
	} else {
		endpoint = "/v1/async/transcriptions"
	}

	requestURL, err := url.JoinPath(c.baseURL, endpoint)
	if err != nil {
		return "", fmt.Errorf("failed to build request URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", requestURL, &buf)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("async API returned status %d: %s", resp.StatusCode, string(body))
	}

	var taskResp AsyncTaskResponse
	if err := json.NewDecoder(resp.Body).Decode(&taskResp); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	return taskResp.TaskID, nil
}

// getTaskStatus gets the status of an async task
func (c *WhisperClient) getTaskStatus(ctx context.Context, taskID string) (status string, result string, err error) {
	taskURL, err := url.JoinPath(c.baseURL, "/v1/tasks/", taskID)
	if err != nil {
		return "", "", fmt.Errorf("failed to build task URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", taskURL, nil)
	if err != nil {
		return "", "", fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		// Task not found - treat as failed (e.g., server restarted and lost task)
		return "failed", "task not found (server may have restarted)", nil
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("task API returned status %d: %s", resp.StatusCode, string(body))
	}

	var taskResp AsyncTaskResponse
	if err := json.NewDecoder(resp.Body).Decode(&taskResp); err != nil {
		return "", "", fmt.Errorf("failed to decode response: %w", err)
	}

	if taskResp.Status == "failed" {
		return taskResp.Status, taskResp.Error, nil
	}
	return taskResp.Status, taskResp.Result, nil
}

// cancelTask explicitly requests the server to cancel a pending/processing task.
func (c *WhisperClient) cancelTask(taskID string) error {
	taskURL, err := url.JoinPath(c.baseURL, "/v1/tasks/", taskID, "/cancel")
	if err != nil {
		return fmt.Errorf("failed to build task cancel URL: %w", err)
	}

	// Use a new background context with a short timeout, since the parent context is already cancelled
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", taskURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create cancel request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send cancel request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cancel API returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}
