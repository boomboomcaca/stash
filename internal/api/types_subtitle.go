package api

// SubtitleConfig represents the subtitle configuration
type SubtitleConfig struct {
	WhisperURL      string `json:"whisper_url"`
	Enabled         bool   `json:"enabled"`
	AutoGenerate    bool   `json:"auto_generate"`
	DefaultLanguage string `json:"default_language"`
	SkipIfExists    bool   `json:"skip_if_exists"`
	Timeout         int    `json:"timeout"`
}

// SubtitleConfigInput represents input for configuring subtitle settings
type SubtitleConfigInput struct {
	WhisperURL      *string `json:"whisper_url"`
	Enabled         *bool   `json:"enabled"`
	AutoGenerate    *bool   `json:"auto_generate"`
	DefaultLanguage *string `json:"default_language"`
	SkipIfExists    *bool   `json:"skip_if_exists"`
	Timeout         *int    `json:"timeout"`
}

// GenerateSubtitleResult represents the result of subtitle generation
type GenerateSubtitleResult struct {
	Success      bool    `json:"success"`
	SubtitlePath *string `json:"subtitle_path"`
	Language     *string `json:"language"`
	Message      *string `json:"message"`
}
