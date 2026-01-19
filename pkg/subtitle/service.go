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
	config        *SubtitleConfig
	whisperClient *WhisperClient
	ffmpegPath    string
	mutex         sync.RWMutex
}

// NewService creates a new subtitle service
func NewService(config *SubtitleConfig) *Service {
	s := &Service{
		config: config,
	}
	s.initWhisperClient()
	return s
}

func (s *Service) initWhisperClient() {
	if s.config == nil {
		return
	}
	timeout := time.Duration(s.config.Timeout) * time.Second
	s.whisperClient = NewWhisperClient(s.config.WhisperURL, timeout)
}

// UpdateConfig updates the service configuration
func (s *Service) UpdateConfig(config *SubtitleConfig) {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	s.config = config
	s.initWhisperClient()
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
func (s *Service) GenerateSubtitle(ctx context.Context, scene *models.Scene, language string) (*GenerateSubtitleResult, error) {
	s.mutex.RLock()
	config := s.config
	client := s.whisperClient
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

	logger.Infof("Extracted audio to %s, sending to Whisper...", audioPath)

	// Transcribe audio
	result, err := client.Transcribe(ctx, audioPath, language)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrTranscribeFailed, err)
	}

	// Save subtitle file
	if err := os.WriteFile(subtitlePath, []byte(result.Content), 0644); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSaveSubtitleFailed, err)
	}

	logger.Infof("Subtitle saved to %s", subtitlePath)

	return &GenerateSubtitleResult{
		Success:      true,
		SubtitlePath: subtitlePath,
		Language:     language,
		Message:      "subtitle generated successfully",
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
