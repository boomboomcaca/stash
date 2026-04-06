package subtitle

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"github.com/stashapp/stash/pkg/logger"
)

// SubtitleConfig holds the configuration for the subtitle service
type SubtitleConfig struct {
	// General settings
	Enabled         bool   `json:"enabled"`
	DefaultLanguage string `json:"default_language"`
	SkipIfExists    bool   `json:"skip_if_exists"`
	Timeout         int    `json:"timeout"` // in seconds

	// Whisper settings (local generation as fallback)
	WhisperEnabled   bool   `json:"whisper_enabled"`
	WhisperURL       string `json:"whisper_url"`
	WhisperTranslate bool   `json:"whisper_translate"` // If true, translate non-English audio to English
}

// DefaultConfig returns the default subtitle configuration
func DefaultConfig() *SubtitleConfig {
	// Try to auto-detect Whisper service
	whisperURL := autoDetectWhisperURL()

	return &SubtitleConfig{
		// General
		Enabled:         true,
		DefaultLanguage: "en",
		SkipIfExists:    true,
		Timeout:         300, // 5 minutes
		// Whisper (enabled)
		WhisperEnabled:   true,
		WhisperURL:       whisperURL,
		WhisperTranslate: true, // Default to translate mode for mixed language videos
	}
}

// autoDetectWhisperURL tries to detect available Whisper service
func autoDetectWhisperURL() string {
	candidateURLs := []string{
		"http://192.168.1.113:8000", // Whisper GPU server (Windows)
		"http://localhost:8000",
		"http://127.0.0.1:8000",
	}

	client := &http.Client{
		Timeout: 2 * time.Second,
	}

	for _, baseURL := range candidateURLs {
		healthURL, err := url.JoinPath(baseURL, "/health")
		if err != nil {
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		req, err := http.NewRequestWithContext(ctx, "GET", healthURL, nil)
		if err != nil {
			cancel()
			continue
		}

		resp, err := client.Do(req)
		cancel()

		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			logger.Infof("Whisper service auto-detected at %s", baseURL)
			return baseURL
		}

		if resp != nil {
			resp.Body.Close()
		}
	}

	// Default to 192.168.1.113 if no service found
	logger.Warn("No Whisper service detected, using default 192.168.1.113:8000")
	return "http://192.168.1.113:8000"
}

// Validate checks if the configuration is valid
func (c *SubtitleConfig) Validate() error {
	if c.WhisperURL == "" {
		return ErrWhisperURLEmpty
	}
	if c.Timeout <= 0 {
		c.Timeout = 300
	}
	return nil
}
