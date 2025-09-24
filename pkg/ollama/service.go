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
		PromptTemplate: `解释: 请解释一下这句话中这个词的用法<WORD>： <CONTEXT>

请用中文回答，包含以下信息：
1. 词性
2. 在此上下文中的含义
3. 使用示例（如果适用）

请保持回答简洁明了。`,
	}
}

// OllamaRequest represents a request to Ollama API
type OllamaRequest struct {
	Model   string                 `json:"model"`
	Prompt  string                 `json:"prompt"`
	Stream  bool                   `json:"stream"`
	Options map[string]interface{} `json:"options,omitempty"`
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
	Word        string                 `json:"word"`
	Definitions []DictionaryDefinition `json:"definitions"`
	Etymology   string                 `json:"etymology"`
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

// Generate generates text using Ollama
func (s *Service) Generate(ctx context.Context, prompt string, model string) (string, error) {
	if model == "" {
		model = s.config.Model
	}

	generateURL, err := url.JoinPath(s.config.BaseURL, "/api/generate")
	if err != nil {
		return "", fmt.Errorf("failed to build generate URL: %w", err)
	}

	requestData := OllamaRequest{
		Model:  model,
		Prompt: prompt,
		Stream: false,
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

	req, err := http.NewRequestWithContext(ctx, "POST", generateURL, bytes.NewBuffer(requestBody))
	if err != nil {
		return "", fmt.Errorf("failed to create generate request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	s.logger.WithFields(logrus.Fields{
		"model":      model,
		"prompt_len": len(prompt),
	}).Debug("Generating text with Ollama")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to generate text: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(body))
	}

	var ollamaResp OllamaResponse
	if err := json.NewDecoder(resp.Body).Decode(&ollamaResp); err != nil {
		return "", fmt.Errorf("failed to decode generate response: %w", err)
	}

	s.logger.WithFields(logrus.Fields{
		"model":         model,
		"response_len":  len(ollamaResp.Response),
		"total_duration": ollamaResp.TotalDuration,
	}).Debug("Generated text with Ollama")

	return ollamaResp.Response, nil
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

// parseExplanation parses the Ollama explanation into a DictionaryEntry
func (s *Service) parseExplanation(word, explanation string) *DictionaryEntry {
	lines := strings.Split(explanation, "\n")
	
	var partOfSpeech string = "unknown"
	var meaning string = explanation
	var examples []string

	// Try to extract structured information from the response
	for _, line := range lines {
		trimmedLine := strings.TrimSpace(line)
		if trimmedLine == "" {
			continue
		}

		// Look for part of speech indicators
		if strings.Contains(trimmedLine, "词性") || strings.Contains(trimmedLine, "：") {
			if strings.Contains(trimmedLine, "词性") {
				parts := strings.Split(trimmedLine, "：")
				if len(parts) > 1 {
					partOfSpeech = strings.TrimSpace(parts[1])
				}
			}
		}

		// Look for examples
		if strings.Contains(trimmedLine, "示例") || strings.Contains(trimmedLine, "例子") || strings.Contains(trimmedLine, "例：") {
			if strings.Contains(trimmedLine, "：") {
				parts := strings.Split(trimmedLine, "：")
				if len(parts) > 1 {
					example := strings.TrimSpace(parts[1])
					if example != "" {
						examples = append(examples, example)
					}
				}
			}
		}
	}

	// Try to extract main meaning
	if meaning == explanation {
		// Look for meaning line
		for _, line := range lines {
			trimmedLine := strings.TrimSpace(line)
			if strings.Contains(trimmedLine, "含义") && strings.Contains(trimmedLine, "：") {
				parts := strings.Split(trimmedLine, "：")
				if len(parts) > 1 {
					meaning = strings.TrimSpace(parts[1])
					break
				}
			}
		}

		// If still not found, use first substantial line
		if meaning == explanation {
			for _, line := range lines {
				trimmedLine := strings.TrimSpace(line)
				if len(trimmedLine) > 10 && 
					!strings.Contains(trimmedLine, "词性") && 
					!strings.Contains(trimmedLine, "示例") {
					meaning = trimmedLine
					break
				}
			}
		}
	}

	return &DictionaryEntry{
		Word: word,
		Definitions: []DictionaryDefinition{
			{
				PartOfSpeech: strings.TrimSpace(partOfSpeech),
				Meaning:      strings.TrimSpace(meaning),
				Examples:     examples,
			},
		},
		Etymology: "AI解释 (Ollama)",
	}
}
