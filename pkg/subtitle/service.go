package subtitle

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/stashapp/stash/pkg/fsutil"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
)

// Service provides subtitle generation functionality
type Service struct {
	config              *SubtitleConfig
	whisperClient       *WhisperClient
	openSubtitlesClient *OpenSubtitlesClient
	ffmpegPath          string
	mutex               sync.RWMutex
}

// NewService creates a new subtitle service
func NewService(config *SubtitleConfig) *Service {
	s := &Service{
		config: config,
	}
	s.initClients()
	return s
}

func (s *Service) initClients() {
	if s.config == nil {
		return
	}
	timeout := time.Duration(s.config.Timeout) * time.Second

	// Initialize Whisper client
	if s.config.WhisperEnabled && s.config.WhisperURL != "" {
		s.whisperClient = NewWhisperClient(s.config.WhisperURL, timeout)
	}

	// Initialize OpenSubtitles client
	if s.config.OpenSubtitlesEnabled && s.config.OpenSubtitlesAPIKey != "" {
		s.openSubtitlesClient = NewOpenSubtitlesClient(s.config.OpenSubtitlesAPIKey, timeout)
	}
}

// UpdateConfig updates the service configuration
func (s *Service) UpdateConfig(config *SubtitleConfig) {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	s.config = config
	s.initClients()
}

// GetConfig returns the current configuration
func (s *Service) GetConfig() *SubtitleConfig {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	return s.config
}

// SetFFmpegPath sets the path to ffmpeg executable
func (s *Service) SetFFmpegPath(path string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.ffmpegPath = path
}

// GenerateSubtitleResult holds the result of subtitle generation
type GenerateSubtitleResult struct {
	Success      bool   `json:"success"`
	SubtitlePath string `json:"subtitle_path"`
	Language     string `json:"language"`
	Message      string `json:"message"`
}

// GenerateSubtitle generates a subtitle for the given scene
// It first tries to fetch from OpenSubtitles, then falls back to Whisper generation
func (s *Service) GenerateSubtitle(ctx context.Context, scene *models.Scene, language string) (*GenerateSubtitleResult, error) {
	s.mutex.RLock()
	config := s.config
	whisperClient := s.whisperClient
	openSubtitlesClient := s.openSubtitlesClient
	ffmpegPath := s.ffmpegPath
	s.mutex.RUnlock()

	if config == nil || !config.Enabled {
		return nil, ErrSubtitleDisabled
	}

	if language == "" {
		language = config.DefaultLanguage
	}

	// Get video file path
	videoPath := scene.Path
	if videoPath == "" {
		return nil, ErrNoVideoFile
	}

	// Check if subtitle already exists
	subtitlePath := getSubtitlePath(videoPath)
	if config.SkipIfExists {
		exists, _ := fsutil.FileExists(subtitlePath)
		if exists {
			return &GenerateSubtitleResult{
				Success:      true,
				SubtitlePath: subtitlePath,
				Language:     language,
				Message:      "subtitle already exists",
			}, nil
		}
	}

	// Step 1: Try OpenSubtitles if enabled
	if config.OpenSubtitlesEnabled && openSubtitlesClient != nil {
		result, err := s.fetchFromOpenSubtitles(ctx, videoPath, subtitlePath, language, openSubtitlesClient)
		if err == nil && result.Success {
			return result, nil
		}
		if err != nil {
			logger.Warnf("OpenSubtitles fetch failed: %v, falling back to Whisper", err)
		}
	}

	// Step 2: Fall back to Whisper generation
	if !config.WhisperEnabled || whisperClient == nil {
		return nil, fmt.Errorf("no subtitle source available: OpenSubtitles failed and Whisper is disabled")
	}

	return s.generateWithWhisper(ctx, videoPath, subtitlePath, language, config.WhisperTranslate, whisperClient, ffmpegPath)
}

// fetchFromOpenSubtitles tries to fetch subtitles from OpenSubtitles
func (s *Service) fetchFromOpenSubtitles(ctx context.Context, videoPath, subtitlePath, language string, client *OpenSubtitlesClient) (*GenerateSubtitleResult, error) {
	// Calculate video hash
	hash, err := CalculateOSHash(videoPath)
	if err != nil {
		return nil, fmt.Errorf("failed to calculate video hash: %w", err)
	}

	logger.Infof("Searching OpenSubtitles with hash: %s, language: %s", hash, language)

	// Search for subtitles
	results, err := client.Search(ctx, hash, language)
	if err != nil {
		return nil, fmt.Errorf("OpenSubtitles search failed: %w", err)
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("no subtitles found on OpenSubtitles")
	}

	// Download the first (best) result
	logger.Infof("Found %d subtitles, downloading: %s", len(results), results[0].FileName)

	content, err := client.Download(ctx, results[0].ID)
	if err != nil {
		return nil, fmt.Errorf("failed to download subtitle: %w", err)
	}

	// Save subtitle file
	if err := os.WriteFile(subtitlePath, content, 0644); err != nil {
		return nil, fmt.Errorf("failed to save subtitle: %w", err)
	}

	logger.Infof("Subtitle fetched from OpenSubtitles and saved to %s", subtitlePath)

	return &GenerateSubtitleResult{
		Success:      true,
		SubtitlePath: subtitlePath,
		Language:     language,
		Message:      "subtitle fetched from OpenSubtitles",
	}, nil
}

// generateWithWhisper generates subtitles using Whisper
func (s *Service) generateWithWhisper(ctx context.Context, videoPath, subtitlePath, language string, translate bool, client *WhisperClient, ffmpegPath string) (*GenerateSubtitleResult, error) {
	// Check Whisper service availability
	if err := client.HealthCheck(ctx); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrWhisperUnavailable, err)
	}

	// Extract audio from video
	audioPath, err := s.extractAudio(ctx, videoPath, ffmpegPath)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAudioExtractFailed, err)
	}
	defer os.Remove(audioPath) // Clean up temp audio file

	mode := "transcribe"
	if translate {
		mode = "translate to English"
	}
	logger.Infof("Extracted audio to %s, sending to Whisper (%s)...", audioPath, mode)

	// Transcribe/translate audio
	result, err := client.Transcribe(ctx, audioPath, language, translate)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrTranscribeFailed, err)
	}

	// Save subtitle file
	if err := os.WriteFile(subtitlePath, []byte(result.Content), 0644); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSaveSubtitleFailed, err)
	}

	msg := "subtitle generated by Whisper"
	if translate {
		msg = "subtitle translated to English by Whisper"
	}
	logger.Infof("Subtitle generated by Whisper and saved to %s", subtitlePath)

	return &GenerateSubtitleResult{
		Success:      true,
		SubtitlePath: subtitlePath,
		Language:     result.Language,
		Message:      msg,
	}, nil
}

// getSubtitlePath returns the subtitle file path for a video
func getSubtitlePath(videoPath string) string {
	ext := filepath.Ext(videoPath)
	basePath := strings.TrimSuffix(videoPath, ext)
	return basePath + ".srt"
}

// extractAudio extracts audio from video file using ffmpeg
func (s *Service) extractAudio(ctx context.Context, videoPath string, ffmpegPath string) (string, error) {
	if ffmpegPath == "" {
		ffmpegPath = "ffmpeg"
	}

	// Create temp file for audio
	tempDir := os.TempDir()
	audioFileName := fmt.Sprintf("stash_audio_%d.mp3", time.Now().UnixNano())
	audioPath := filepath.Join(tempDir, audioFileName)

	// Build ffmpeg command
	args := []string{
		"-i", videoPath,
		"-vn", // No video
		"-acodec", "libmp3lame",
		"-ab", "128k",
		"-ar", "16000", // 16kHz sample rate (good for speech)
		"-ac", "1", // Mono
		"-y", // Overwrite output
		audioPath,
	}

	cmd := exec.CommandContext(ctx, ffmpegPath, args...)

	// Capture stderr for error messages
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("ffmpeg error: %v, stderr: %s", err, stderr.String())
	}

	return audioPath, nil
}

// HasSubtitle checks if a scene already has a subtitle file
func (s *Service) HasSubtitle(scene *models.Scene) bool {
	if scene.Path == "" {
		return false
	}
	subtitlePath := getSubtitlePath(scene.Path)
	exists, _ := fsutil.FileExists(subtitlePath)
	return exists
}

// TestConnection tests the connection to the Whisper service
func (s *Service) TestConnection(ctx context.Context) error {
	s.mutex.RLock()
	client := s.whisperClient
	s.mutex.RUnlock()

	if client == nil {
		return ErrSubtitleDisabled
	}

	return client.HealthCheck(ctx)
}
