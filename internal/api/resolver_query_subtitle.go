package api

import (
	"context"
	"fmt"

	"github.com/stashapp/stash/internal/manager"
	"github.com/stashapp/stash/pkg/subtitle"
)

func (r *queryResolver) SubtitleConfig(ctx context.Context) (*SubtitleConfig, error) {
	mgr := manager.GetInstance()
	subtitleService := mgr.SubtitleService
	if subtitleService == nil {
		// Return default config if service not initialized
		config := subtitle.DefaultConfig()
		return &SubtitleConfig{
			Enabled:         config.Enabled,
			DefaultLanguage: config.DefaultLanguage,
			SkipIfExists:    config.SkipIfExists,
			Timeout:         config.Timeout,

			WhisperEnabled:     config.WhisperEnabled,
			WhisperURL:         config.WhisperURL,
			WhisperTranslate:   config.WhisperTranslate,
			WhisperAiNormalize: config.WhisperAINormalize,
		}, nil
	}

	config := subtitleService.GetConfig()
	if config == nil {
		config = subtitle.DefaultConfig()
	}

	return &SubtitleConfig{
		Enabled:         config.Enabled,
		DefaultLanguage: config.DefaultLanguage,
		SkipIfExists:    config.SkipIfExists,
		Timeout:         config.Timeout,

		WhisperEnabled:     config.WhisperEnabled,
		WhisperURL:         config.WhisperURL,
		WhisperTranslate:   config.WhisperTranslate,
		WhisperAiNormalize: config.WhisperAINormalize,
	}, nil
}

func (r *queryResolver) TestSubtitleConnection(ctx context.Context) (bool, error) {
	mgr := manager.GetInstance()
	subtitleService := mgr.SubtitleService
	if subtitleService == nil {
		return false, fmt.Errorf("subtitle service not initialized")
	}

	err := subtitleService.TestConnection(ctx)
	if err != nil {
		return false, nil
	}

	return true, nil
}
