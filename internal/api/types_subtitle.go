package api

// SubtitleConfig represents the subtitle configuration
type SubtitleConfig struct {
	// General settings
	Enabled         bool   `json:"enabled"`
	DefaultLanguage string `json:"default_language"`
	SkipIfExists    bool   `json:"skip_if_exists"`
	Timeout         int    `json:"timeout"`
	// Whisper settings
	WhisperEnabled     bool   `json:"whisper_enabled"`
	WhisperURL         string `json:"whisper_url"`
	WhisperTranslate   bool   `json:"whisper_translate"`
	WhisperAiNormalize bool   `json:"whisper_ai_normalize"`
}

// SubtitleConfigInput represents input for configuring subtitle settings
type SubtitleConfigInput struct {
	// General settings
	Enabled         *bool   `json:"enabled"`
	DefaultLanguage *string `json:"default_language"`
	SkipIfExists    *bool   `json:"skip_if_exists"`
	Timeout         *int    `json:"timeout"`
	// Whisper settings
	WhisperEnabled     *bool   `json:"whisper_enabled"`
	WhisperURL         *string `json:"whisper_url"`
	WhisperTranslate   *bool   `json:"whisper_translate"`
	WhisperAiNormalize *bool   `json:"whisper_ai_normalize"`
}
