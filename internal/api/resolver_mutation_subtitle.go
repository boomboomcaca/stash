package api

import (
	"context"
	"fmt"
	"strconv"

	"github.com/stashapp/stash/internal/manager"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/subtitle"
)

func (r *mutationResolver) GenerateSubtitle(ctx context.Context, sceneID string, language *string) (*GenerateSubtitleResult, error) {
	mgr := manager.GetInstance()
	subtitleService := mgr.SubtitleService
	if subtitleService == nil {
		return nil, fmt.Errorf("subtitle service not initialized")
	}

	id, err := strconv.Atoi(sceneID)
	if err != nil {
		return nil, fmt.Errorf("invalid scene ID: %w", err)
	}

	var scene *models.Scene
	if err := r.withReadTxn(ctx, func(ctx context.Context) error {
		var err error
		scene, err = r.repository.Scene.Find(ctx, id)
		return err
	}); err != nil {
		return nil, err
	}

	if scene == nil {
		return nil, fmt.Errorf("scene not found: %d", id)
	}

	lang := ""
	if language != nil {
		lang = *language
	}

	result, err := subtitleService.GenerateSubtitle(ctx, scene, lang)
	if err != nil {
		return &GenerateSubtitleResult{
			Success: false,
			Message: stringPtr(err.Error()),
		}, nil
	}

	return &GenerateSubtitleResult{
		Success:      result.Success,
		SubtitlePath: stringPtr(result.SubtitlePath),
		Language:     stringPtr(result.Language),
		Message:      stringPtr(result.Message),
	}, nil
}

func (r *mutationResolver) GenerateSubtitles(ctx context.Context, sceneIds []string, language *string) (string, error) {
	mgr := manager.GetInstance()
	subtitleService := mgr.SubtitleService
	if subtitleService == nil {
		return "", fmt.Errorf("subtitle service not initialized")
	}

	ids := make([]int, len(sceneIds))
	for i, idStr := range sceneIds {
		id, err := strconv.Atoi(idStr)
		if err != nil {
			return "", fmt.Errorf("invalid scene ID: %s", idStr)
		}
		ids[i] = id
	}

	lang := ""
	if language != nil {
		lang = *language
	}

	job := &manager.AutoSubtitleJob{
		SceneIDs:        ids,
		Language:        lang,
		SubtitleService: subtitleService,
		Repository:      mgr.Repository,
	}

	jobID := mgr.JobManager.Add(ctx, "Generating subtitles...", job)
	return strconv.Itoa(jobID), nil
}

func (r *mutationResolver) AutoGenerateSubtitles(ctx context.Context, language *string) (string, error) {
	mgr := manager.GetInstance()
	subtitleService := mgr.SubtitleService
	if subtitleService == nil {
		return "", fmt.Errorf("subtitle service not initialized")
	}

	lang := ""
	if language != nil {
		lang = *language
	}

	job := &manager.AutoSubtitleJob{
		SceneIDs:        nil, // Process all scenes without subtitles
		Language:        lang,
		SubtitleService: subtitleService,
		Repository:      mgr.Repository,
	}

	jobID := mgr.JobManager.Add(ctx, "Auto-generating subtitles for all scenes...", job)
	return strconv.Itoa(jobID), nil
}

func (r *mutationResolver) ConfigureSubtitle(ctx context.Context, input SubtitleConfigInput) (*SubtitleConfig, error) {
	mgr := manager.GetInstance()
	subtitleService := mgr.SubtitleService
	if subtitleService == nil {
		return nil, fmt.Errorf("subtitle service not initialized")
	}

	config := subtitleService.GetConfig()
	if config == nil {
		config = subtitle.DefaultConfig()
	}

	// Update config with input values
	// General settings
	if input.Enabled != nil {
		config.Enabled = *input.Enabled
	}
	if input.DefaultLanguage != nil {
		config.DefaultLanguage = *input.DefaultLanguage
	}
	if input.SkipIfExists != nil {
		config.SkipIfExists = *input.SkipIfExists
	}
	if input.Timeout != nil {
		config.Timeout = *input.Timeout
	}

	// OpenSubtitles settings
	if input.OpenSubtitlesEnabled != nil {
		config.OpenSubtitlesEnabled = *input.OpenSubtitlesEnabled
	}
	if input.OpenSubtitlesAPIKey != nil {
		config.OpenSubtitlesAPIKey = *input.OpenSubtitlesAPIKey
	}

	// Whisper settings
	if input.WhisperEnabled != nil {
		config.WhisperEnabled = *input.WhisperEnabled
	}
	if input.WhisperURL != nil {
		config.WhisperURL = *input.WhisperURL
	}
	if input.WhisperTranslate != nil {
		config.WhisperTranslate = *input.WhisperTranslate
	}

	subtitleService.UpdateConfig(config)

	return &SubtitleConfig{
		Enabled:              config.Enabled,
		DefaultLanguage:      config.DefaultLanguage,
		SkipIfExists:         config.SkipIfExists,
		Timeout:              config.Timeout,
		OpenSubtitlesEnabled: config.OpenSubtitlesEnabled,
		OpenSubtitlesAPIKey:  config.OpenSubtitlesAPIKey,
		WhisperEnabled:       config.WhisperEnabled,
		WhisperURL:           config.WhisperURL,
		WhisperTranslate:     config.WhisperTranslate,
	}, nil
}

func stringPtr(s string) *string {
	return &s
}
