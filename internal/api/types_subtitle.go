package api

// SubtitleConfig represents the subtitle configuration
type SubtitleConfig struct {
	// General settings
	Enabled            bool   `json:"enabled"`
	DefaultLanguage    string `json:"default_language"`
	SkipIfExists       bool   `json:"skip_if_exists"`
	Timeout            int    `json:"timeout"`
	AutoGenerateOnScan bool   `json:"auto_generate_on_scan"`

	// OpenSubtitles settings
	OpenSubtitlesEnabled bool   `json:"opensubtitles_enabled"`
	OpenSubtitlesAPIKey  string `json:"opensubtitles_api_key"`

	// Whisper settings
	WhisperEnabled   bool   `json:"whisper_enabled"`
	WhisperURL       string `json:"whisper_url"`
	WhisperTranslate bool   `json:"whisper_translate"`
}

// SubtitleConfigInput represents input for configuring subtitle settings
type SubtitleConfigInput struct {
	// General settings
	Enabled            *bool   `json:"enabled"`
	DefaultLanguage    *string `json:"default_language"`
	SkipIfExists       *bool   `json:"skip_if_exists"`
	Timeout            *int    `json:"timeout"`
	AutoGenerateOnScan *bool   `json:"auto_generate_on_scan"`

	// OpenSubtitles settings
	OpenSubtitlesEnabled *bool   `json:"opensubtitles_enabled"`
	OpenSubtitlesAPIKey  *string `json:"opensubtitles_api_key"`

	// Whisper settings
	WhisperEnabled   *bool   `json:"whisper_enabled"`
	WhisperURL       *string `json:"whisper_url"`
	WhisperTranslate *bool   `json:"whisper_translate"`
}

// GenerateSubtitleResult represents the result of subtitle generation
type GenerateSubtitleResult struct {
	Success      bool    `json:"success"`
	SubtitlePath *string `json:"subtitle_path"`
	Language     *string `json:"language"`
	Message      *string `json:"message"`
}
