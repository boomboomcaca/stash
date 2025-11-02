package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

// OllamaConfig represents the configuration for Ollama service
type OllamaConfig struct {
	BaseURL                   string `json:"baseUrl"`
	Model                     string `json:"model"`
	Timeout                   int    `json:"timeout"` // in milliseconds
	Enabled                   bool   `json:"enabled"`
	FallbackToTraditionalDict bool   `json:"fallbackToTraditionalDict"`
	PromptTemplate            string `json:"promptTemplate"`
}

// DefaultConfig returns the default Ollama configuration
func DefaultConfig() *OllamaConfig {
	return &OllamaConfig{
		BaseURL:                   "http://192.168.1.113:11434",
		Model:                     "qwen3:latest",
		Timeout:                   30000, // 30 seconds
		Enabled:                   true,
		FallbackToTraditionalDict: true,
		PromptTemplate: `请严格按照以下格式回答，不要添加额外的标题、分割线或格式：

**美音音标：** [音标]
**词性：** [词性名称：<WORD>的中文翻译]
**含义：** [解释一下这句话中这个词的用法<WORD>： <CONTEXT>]
**用法说明：** [解释一下这句话中这个词的语法<WORD>： <CONTEXT>]

要求：
1. 直接回答，不要前言或总结
2. 每部分内容简洁明了
3. 美音音标请用国际音标（IPA）格式
4. 词性部分必须包含单词的中文翻译，多个翻译用顿号分隔
5. 不要使用markdown标题符号（#）或分割线（---）`,
	}
}

// OllamaRequest represents a request to Ollama API
type OllamaRequest struct {
	Model   string                 `json:"model"`
	Prompt  string                 `json:"prompt"`
	Stream  bool                   `json:"stream"`
	Options map[string]interface{} `json:"options,omitempty"`
}

// OllamaChatMessage represents a message in chat format
type OllamaChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// OllamaChatRequest represents a chat request to Ollama API
type OllamaChatRequest struct {
	Model    string                 `json:"model"`
	Messages []OllamaChatMessage    `json:"messages"`
	Stream   bool                   `json:"stream"`
	Think    bool                   `json:"think"`
	Options  map[string]interface{} `json:"options,omitempty"`
}

// OllamaResponse represents a response from Ollama API
type OllamaResponse struct {
	Model              string    `json:"model"`
	CreatedAt          time.Time `json:"created_at"`
	Response           string    `json:"response"`
	Done               bool      `json:"done"`
	Context            []int     `json:"context,omitempty"`
	TotalDuration      int64     `json:"total_duration,omitempty"`
	LoadDuration       int64     `json:"load_duration,omitempty"`
	PromptEvalCount    int       `json:"prompt_eval_count,omitempty"`
	PromptEvalDuration int64     `json:"prompt_eval_duration,omitempty"`
	EvalCount          int       `json:"eval_count,omitempty"`
	EvalDuration       int64     `json:"eval_duration,omitempty"`
}

// OllamaChatResponse represents a chat response from Ollama API
type OllamaChatResponse struct {
	Model              string            `json:"model"`
	CreatedAt          time.Time         `json:"created_at"`
	Message            OllamaChatMessage `json:"message"`
	Done               bool              `json:"done"`
	DoneReason         string            `json:"done_reason,omitempty"`
	TotalDuration      int64             `json:"total_duration,omitempty"`
	LoadDuration       int64             `json:"load_duration,omitempty"`
	PromptEvalCount    int               `json:"prompt_eval_count,omitempty"`
	PromptEvalDuration int64             `json:"prompt_eval_duration,omitempty"`
	EvalCount          int               `json:"eval_count,omitempty"`
	EvalDuration       int64             `json:"eval_duration,omitempty"`
}

// OllamaModel represents a model from Ollama
type OllamaModel struct {
	Name       string    `json:"name"`
	ModifiedAt time.Time `json:"modified_at"`
	Size       int64     `json:"size"`
	Digest     string    `json:"digest"`
}

// OllamaModelsResponse represents the response from /api/tags
type OllamaModelsResponse struct {
	Models []OllamaModel `json:"models"`
}

// OllamaVersionResponse represents the response from /api/version
type OllamaVersionResponse struct {
	Version string `json:"version"`
}

// DictionaryEntry represents a dictionary entry for word explanation
type DictionaryEntry struct {
	Word          string                 `json:"word"`
	Pronunciation string                 `json:"pronunciation,omitempty"`
	Definitions   []DictionaryDefinition `json:"definitions"`
	Etymology     string                 `json:"etymology"`
}

// DictionaryDefinition represents a word definition
type DictionaryDefinition struct {
	PartOfSpeech string   `json:"partOfSpeech"`
	Meaning      string   `json:"meaning"`
	Examples     []string `json:"examples"`
}

// Service provides Ollama functionality
type Service struct {
	config     *OllamaConfig
	httpClient *http.Client
	logger     *logrus.Entry
}

// NewService creates a new Ollama service
func NewService(config *OllamaConfig) *Service {
	if config == nil {
		config = DefaultConfig()
	}

	timeout := time.Duration(config.Timeout) * time.Millisecond
	if timeout < time.Second {
		timeout = 30 * time.Second
	}

	return &Service{
		config: config,
		httpClient: &http.Client{
			Timeout: timeout,
		},
		logger: logrus.WithField("service", "ollama"),
	}
}

// GetConfig returns the current configuration
func (s *Service) GetConfig() *OllamaConfig {
	return s.config
}

// UpdateConfig updates the service configuration
func (s *Service) UpdateConfig(config *OllamaConfig) {
	if config != nil {
		s.config = config

		// Update HTTP client timeout
		timeout := time.Duration(config.Timeout) * time.Millisecond
		if timeout < time.Second {
			timeout = 30 * time.Second
		}
		s.httpClient.Timeout = timeout
	}
}

// IsAvailable checks if the Ollama service is available
func (s *Service) IsAvailable(ctx context.Context) bool {
	if !s.config.Enabled {
		return false
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	versionURL, err := url.JoinPath(s.config.BaseURL, "/api/version")
	if err != nil {
		s.logger.WithError(err).Error("Failed to build version URL")
		return false
	}

	req, err := http.NewRequestWithContext(ctx, "GET", versionURL, nil)
	if err != nil {
		s.logger.WithError(err).Error("Failed to create version request")
		return false
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		s.logger.WithError(err).Debug("Ollama service not available")
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK
}

// GetModels retrieves the list of available models from Ollama
func (s *Service) GetModels(ctx context.Context) ([]string, error) {
	tagsURL, err := url.JoinPath(s.config.BaseURL, "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("failed to build tags URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", tagsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create tags request: %w", err)
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get models: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	var modelsResp OllamaModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&modelsResp); err != nil {
		return nil, fmt.Errorf("failed to decode models response: %w", err)
	}

	models := make([]string, len(modelsResp.Models))
	for i, model := range modelsResp.Models {
		models[i] = model.Name
	}

	return models, nil
}

// Generate generates text using Ollama chat API with think mode disabled
func (s *Service) Generate(ctx context.Context, prompt string, model string) (string, error) {
	if model == "" {
		model = s.config.Model
	}

	chatURL, err := url.JoinPath(s.config.BaseURL, "/api/chat")
	if err != nil {
		return "", fmt.Errorf("failed to build chat URL: %w", err)
	}

	requestData := OllamaChatRequest{
		Model: model,
		Messages: []OllamaChatMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		Stream: false,
		Think:  false, // Disable think mode
		Options: map[string]interface{}{
			"temperature": 0.3, // Lower temperature for more consistent explanations
			"top_k":       40,
			"top_p":       0.9,
		},
	}

	requestBody, err := json.Marshal(requestData)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", chatURL, bytes.NewBuffer(requestBody))
	if err != nil {
		return "", fmt.Errorf("failed to create chat request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	s.logger.WithFields(logrus.Fields{
		"model":      model,
		"prompt_len": len(prompt),
		"think":      false,
	}).Debug("Generating text with Ollama (think disabled)")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to generate text: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(body))
	}

	var chatResp OllamaChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return "", fmt.Errorf("failed to decode chat response: %w", err)
	}

	s.logger.WithFields(logrus.Fields{
		"model":          model,
		"response_len":   len(chatResp.Message.Content),
		"total_duration": chatResp.TotalDuration,
	}).Debug("Generated text with Ollama")

	return chatResp.Message.Content, nil
}

// ExplainWord explains a word in context using Ollama
func (s *Service) ExplainWord(ctx context.Context, word, context, language string) (*DictionaryEntry, error) {
	prompt := s.buildPrompt(word, context)

	explanation, err := s.Generate(ctx, prompt, "")
	if err != nil {
		return nil, fmt.Errorf("failed to explain word: %w", err)
	}

	// Parse the explanation into a structured format
	return s.parseExplanation(word, explanation), nil
}

// buildPrompt builds a prompt from the template
func (s *Service) buildPrompt(word, context string) string {
	prompt := s.config.PromptTemplate
	prompt = strings.ReplaceAll(prompt, "<WORD>", word)
	prompt = strings.ReplaceAll(prompt, "<CONTEXT>", context)
	return prompt
}

// parseExplanation parses structured Ollama explanation into a dictionary entry
func (s *Service) parseExplanation(word, explanation string) *DictionaryEntry {
	// Clean up the explanation text
	cleanExplanation := s.cleanExplanationText(explanation)

	// Try to parse structured content
	pronunciation, partOfSpeech, meaning, usageNote, _ := s.parseStructuredExplanation(cleanExplanation)

	// Build the complete meaning text
	completeMeaning := meaning
	if usageNote != "" {
		completeMeaning += "\n\n" + usageNote
	}

	entry := &DictionaryEntry{
		Word: word,
		Definitions: []DictionaryDefinition{
			{
				PartOfSpeech: partOfSpeech,
				Meaning:      completeMeaning,
			},
		},
	}

	// Add pronunciation to entry if available
	if pronunciation != "" {
		entry.Pronunciation = pronunciation
	}

	return entry
}

// cleanExplanationText removes excessive formatting and cleans up the text
func (s *Service) cleanExplanationText(text string) string {
	// Remove common unwanted phrases and elements
	unwantedPhrases := []string{
		"×Close",
		"Dictionary:",
		"当然可以！",
		"我们来详细解释一下",
		"让我来解释",
		"根据你的要求",
		"按照格式",
	}

	for _, phrase := range unwantedPhrases {
		text = strings.ReplaceAll(text, phrase, "")
	}

	// Remove excessive separators and formatting
	text = strings.ReplaceAll(text, "---", "")
	text = strings.ReplaceAll(text, "===", "")
	text = strings.ReplaceAll(text, "###", "")
	text = strings.ReplaceAll(text, "####", "")

	// Remove multiple consecutive newlines
	for strings.Contains(text, "\n\n\n") {
		text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
	}

	// Remove leading/trailing whitespace and empty lines
	lines := strings.Split(text, "\n")
	var cleanLines []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			cleanLines = append(cleanLines, line)
		}
	}

	return strings.Join(cleanLines, "\n")
}

// parseStructuredExplanation attempts to parse structured response
func (s *Service) parseStructuredExplanation(text string) (pronunciation, partOfSpeech, meaning, usageNote string, examples []string) {
	lines := strings.Split(text, "\n")

	currentSection := ""
	var exampleLines []string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Parse structured sections
		if strings.HasPrefix(line, "**美音音标：**") || strings.HasPrefix(line, "**美音音标:**") {
			pronunciation = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "**美音音标：**"), "**美音音标:**"))
			pronunciation = strings.Trim(pronunciation, "[]")
			pronunciation = strings.Trim(pronunciation, "/")
			currentSection = "pronunciation"
		} else if strings.HasPrefix(line, "**词性：**") || strings.HasPrefix(line, "**词性:**") {
			partOfSpeech = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "**词性：**"), "**词性:**"))
			partOfSpeech = strings.Trim(partOfSpeech, "[]")
			currentSection = "pos"
		} else if strings.HasPrefix(line, "**含义：**") || strings.HasPrefix(line, "**含义:**") {
			meaning = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "**含义：**"), "**含义:**"))
			meaning = strings.Trim(meaning, "[]")
			currentSection = "meaning"
		} else if strings.HasPrefix(line, "**用法说明：**") || strings.HasPrefix(line, "**用法说明:**") {
			usageNote = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "**用法说明：**"), "**用法说明:**"))
			usageNote = strings.Trim(usageNote, "[]")
			currentSection = "usage"
		} else if strings.HasPrefix(line, "**例句：**") || strings.HasPrefix(line, "**例句:**") {
			exampleText := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "**例句：**"), "**例句:**"))
			if exampleText != "" && !strings.HasPrefix(exampleText, "[") {
				exampleLines = append(exampleLines, exampleText)
			}
			currentSection = "examples"
		} else if currentSection == "meaning" && meaning != "" {
			meaning += " " + line
		} else if currentSection == "usage" && usageNote != "" {
			usageNote += " " + line
		} else if currentSection == "examples" {
			// Handle example lines
			if strings.HasPrefix(line, "-") || strings.HasPrefix(line, "•") || strings.HasPrefix(line, "1.") || strings.HasPrefix(line, "2.") {
				cleaned := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(line, "-"), "•"), "1."))
				cleaned = strings.TrimSpace(strings.TrimPrefix(cleaned, "2."))
				if cleaned != "" {
					exampleLines = append(exampleLines, cleaned)
				}
			} else if line != "" && !strings.HasPrefix(line, "**") {
				exampleLines = append(exampleLines, line)
			}
		}

		// Fallback: if no structured format detected, treat as meaning
		if partOfSpeech == "" && meaning == "" && usageNote == "" && len(exampleLines) == 0 {
			if !strings.HasPrefix(line, "**") && !strings.Contains(line, "###") && !strings.Contains(line, "---") {
				if meaning == "" {
					meaning = line
				} else {
					meaning += " " + line
				}
			}
		}
	}

	// Clean up extracted content
	meaning = strings.TrimSpace(meaning)
	usageNote = strings.TrimSpace(usageNote)
	partOfSpeech = strings.TrimSpace(partOfSpeech)

	// Set default part of speech if not found
	if partOfSpeech == "" {
		partOfSpeech = "词汇"
	}

	// Limit examples to avoid clutter
	if len(exampleLines) > 3 {
		examples = exampleLines[:3]
	} else {
		examples = exampleLines
	}

	return pronunciation, partOfSpeech, meaning, usageNote, examples
}
