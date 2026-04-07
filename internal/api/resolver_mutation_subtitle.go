package api

import (
	"context"
	"fmt"
	"strconv"

	"github.com/stashapp/stash/internal/manager"
	"github.com/stashapp/stash/pkg/subtitle"
)

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
	if input.WhisperAiNormalize != nil {
		config.WhisperAINormalize = *input.WhisperAiNormalize
	}

	subtitleService.UpdateConfig(config)

	return &SubtitleConfig{
		Enabled:            config.Enabled,
		DefaultLanguage:    config.DefaultLanguage,
		SkipIfExists:       config.SkipIfExists,
		Timeout:            config.Timeout,
		WhisperEnabled:     config.WhisperEnabled,
		WhisperURL:         config.WhisperURL,
		WhisperTranslate:   config.WhisperTranslate,
		WhisperAiNormalize: config.WhisperAINormalize,
	}, nil
}
