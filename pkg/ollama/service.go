package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
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
	SystemPrompt              string `json:"systemPrompt"`
	MistralAPIKey             string `json:"mistralApiKey"`
}

// DefaultConfig returns the default Ollama configuration
func DefaultConfig() *OllamaConfig {
	// Auto-detect available Ollama service
	baseURL := autoDetectOllamaURL()

	// 优先从环境变量中读取 Mistral API Key
	mistralKey := os.Getenv("MISTRAL_API_KEY")

	return &OllamaConfig{
		BaseURL:                   baseURL,
		Model:                     "huihui_ai/qwen3-abliterated:8b-v2",
		Timeout:                   30000, // 30 seconds
		Enabled:                   true,
		FallbackToTraditionalDict: true,
		MistralAPIKey:             mistralKey,
		PromptTemplate: `你是一个英语词典。解释单词 '<WORD>' 在以下语境中的含义。
语境：<CONTEXT>

请用以下格式输出（纯文本）：
● 词性：xxx /美式音标/（音标为必填项，必须给出美式英语 IPA 音标）
● 词根拆解：用一行简洁列出，格式如 pre-(前缀,'之前') + dict(词根,'说') + -ion(后缀,名词)
● 释义：xxx
● 语境释义：
● 常见搭配：xxx`,
		SystemPrompt: `你必须全程使用中文进行解释说明（包括词根的含义也必须翻译为中文，不要夹杂英文解释）。纯文本输出，不要用任何符号（如反斜杠、星号、井号）包裹或强调单词。简洁回答。`,
	}
}

// autoDetectOllamaURL tries to detect available Ollama service
func autoDetectOllamaURL() string {
	// List of URLs to try in order of priority
	candidateURLs := []string{
		"http://localhost:11434",            // WSL2, local installation
		"http://host.docker.internal:11434", // Docker Desktop
		"http://192.168.1.113:11434",        // Specific LAN address (fallback)
	}

	client := &http.Client{
		Timeout: 2 * time.Second, // Quick timeout for detection
	}

	for _, baseURL := range candidateURLs {
		versionURL, err := url.JoinPath(baseURL, "/api/version")
		if err != nil {
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		req, err := http.NewRequestWithContext(ctx, "GET", versionURL, nil)
		if err != nil {
			cancel()
			continue
		}

		resp, err := client.Do(req)
		cancel()

		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			logrus.WithField("detected_url", baseURL).Info("Ollama service auto-detected")
			return baseURL
		}

		if resp != nil {
			resp.Body.Close()
		}
	}

	// If no service found, return localhost as default (user can configure later)
	logrus.Warn("No Ollama service detected, using default localhost:11434")
	return "http://localhost:11434"
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

// DictionaryEntry represents a dictionary entry for word explanation
type DictionaryEntry struct {
	Word          string                 `json:"word"`
	Pronunciation string                 `json:"pronunciation,omitempty"`
	Definitions   []DictionaryDefinition `json:"definitions"`
	Morphology    string                 `json:"morphology,omitempty"`
	AISource      string                 `json:"aiSource,omitempty"`
}

// DictionaryDefinition represents a word definition
type DictionaryDefinition struct {
	PartOfSpeech string   `json:"partOfSpeech"`
	Meaning      string   `json:"meaning"`
	Examples     []string `json:"examples"`
}

// Service provides Ollama functionality
type Service struct {
	// mu guards config and httpClient, which are replaced (never mutated in
	// place) by UpdateConfig while requests are in flight.
	mu         sync.RWMutex
	config     *OllamaConfig
	httpClient *http.Client
	logger     *logrus.Entry
}

// snapshot returns a consistent config/client pair for use by a single request.
func (s *Service) snapshot() (*OllamaConfig, *http.Client) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config, s.httpClient
}

// GenerateMistral generates text using Mistral AI chat completions API
func (s *Service) GenerateMistral(ctx context.Context, prompt string, sysPrompt string) (string, error) {
	config, client := s.snapshot()

	apiKey := config.MistralAPIKey
	if apiKey == "" {
		return "", fmt.Errorf("mistral API key is not configured. Please configure it in settings")
	}

	urlStr := "https://api.mistral.ai/v1/chat/completions"

	if sysPrompt == "" {
		sysPrompt = "你必须全程使用中文进行解释说明（包括词根的含义也必须翻译为中文，不要夹杂英文解释）。纯文本输出，不要用任何符号（如反斜杠、星号、井号）包裹或强调单词。简洁回答。"
	}

	requestData := map[string]interface{}{
		"model": "mistral-large-latest",
		"messages": []map[string]interface{}{
			{
				"role":    "system",
				"content": sysPrompt,
			},
			{
				"role":    "user",
				"content": prompt,
			},
		},
		"temperature": 0,
		"max_tokens":  800,
	}

	requestBody, err := json.Marshal(requestData)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", urlStr, bytes.NewBuffer(requestBody))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to generate text with Mistral: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("unexpected status code from Mistral: %d, body: %s", resp.StatusCode, string(body))
	}

	var mistralResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&mistralResp); err != nil {
		return "", fmt.Errorf("failed to decode Mistral response: %w", err)
	}

	if len(mistralResp.Choices) == 0 {
		return "", fmt.Errorf("empty response from Mistral")
	}

	return mistralResp.Choices[0].Message.Content, nil
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
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// UpdateConfig updates the service configuration
func (s *Service) UpdateConfig(config *OllamaConfig) {
	if config != nil {
		timeout := time.Duration(config.Timeout) * time.Millisecond
		if timeout < time.Second {
			timeout = 30 * time.Second
		}

		s.mu.Lock()
		defer s.mu.Unlock()
		s.config = config
		// Replace the client rather than mutating the shared one, which may be
		// in use by concurrent requests
		s.httpClient = &http.Client{Timeout: timeout}
	}
}

// IsAvailable checks if the Ollama service is available
func (s *Service) IsAvailable(ctx context.Context) bool {
	config, client := s.snapshot()

	if !config.Enabled {
		return false
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	versionURL, err := url.JoinPath(config.BaseURL, "/api/version")
	if err != nil {
		s.logger.WithError(err).Error("Failed to build version URL")
		return false
	}

	req, err := http.NewRequestWithContext(ctx, "GET", versionURL, nil)
	if err != nil {
		s.logger.WithError(err).Error("Failed to create version request")
		return false
	}

	resp, err := client.Do(req)
	if err != nil {
		s.logger.WithError(err).Debug("Ollama service not available")
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK
}

// GetModels retrieves the list of available models from Ollama
func (s *Service) GetModels(ctx context.Context) ([]string, error) {
	config, client := s.snapshot()

	tagsURL, err := url.JoinPath(config.BaseURL, "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("failed to build tags URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", tagsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create tags request: %w", err)
	}

	resp, err := client.Do(req)
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
func (s *Service) Generate(ctx context.Context, prompt string, model string, sysPrompt string) (string, error) {
	config, client := s.snapshot()

	if model == "" {
		model = config.Model
	}

	chatURL, err := url.JoinPath(config.BaseURL, "/api/chat")
	if err != nil {
		return "", fmt.Errorf("failed to build chat URL: %w", err)
	}

	if sysPrompt == "" {
		sysPrompt = "你必须全程使用中文进行解释说明（包括词根的含义也必须翻译为中文，不要夹杂英文解释）。纯文本输出，不要用任何符号（如反斜杠、星号、井号）包裹或强调单词。简洁回答。"
	}

	requestData := OllamaChatRequest{
		Model: model,
		Messages: []OllamaChatMessage{
			{
				Role:    "system",
				Content: sysPrompt,
			},
			{
				Role:    "user",
				Content: prompt,
			},
		},
		Stream: false,
		Think:  false, // Disable think mode
		Options: map[string]interface{}{
			"temperature": 0,
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

	resp, err := client.Do(req)
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

// ExplainWord explains a word in context using Mistral or Ollama
func (s *Service) ExplainWord(ctx context.Context, word, contextStr, language, provider string) (*DictionaryEntry, error) {
	prompt := s.buildPrompt(word, contextStr, language)
	sysPrompt := s.getSystemPrompt(language)

	var explanation string
	var err error
	var aiSource string

	switch provider {
	case "ollama":
		// User explicitly requested Ollama
		explanation, err = s.Generate(ctx, prompt, "", sysPrompt)
		if err != nil {
			return nil, fmt.Errorf("failed to explain word with Ollama: %w", err)
		}
		aiSource = "ollama"
	case "mistral":
		// User explicitly requested Mistral
		explanation, err = s.GenerateMistral(ctx, prompt, sysPrompt)
		if err != nil {
			return nil, fmt.Errorf("failed to explain word with Mistral: %w", err)
		}
		aiSource = "mistral"
	default:
		// Default behavior: Try Mistral first, fallback to Ollama
		explanation, err = s.GenerateMistral(ctx, prompt, sysPrompt)
		if err == nil {
			aiSource = "mistral"
		} else {
			// Log Mistral error and fallback to Ollama
			s.logger.WithError(err).Warn("Mistral failed, falling back to Ollama")
			explanation, err = s.Generate(ctx, prompt, "", sysPrompt)
			if err != nil {
				return nil, fmt.Errorf("failed to explain word (both Mistral and Ollama failed): %w", err)
			}
			aiSource = "ollama"
		}
	}

	// Parse the explanation into a structured format
	entry := s.parseExplanation(word, explanation)
	entry.AISource = aiSource
	return entry, nil
}

// getSystemPrompt returns the system prompt based on language
func (s *Service) getSystemPrompt(language string) string {
	if strings.ToLower(language) == "en" {
		return "English only. Plain text, no Markdown. Keep each item to one sentence. Be concise."
	}
	sysPrompt := s.GetConfig().SystemPrompt
	if sysPrompt == "" {
		sysPrompt = "你必须全程使用中文进行解释说明（包括词根的含义也必须翻译为中文，不要夹杂英文解释）。纯文本输出，不要用任何符号（如反斜杠、星号、井号）包裹或强调单词。简洁回答。"
	}
	return sysPrompt
}

// buildPrompt builds a prompt from the template
func (s *Service) buildPrompt(word, contextStr, language string) string {
	var promptTemplate string
	if strings.ToLower(language) == "en" {
		promptTemplate = `Explain the word '<WORD>' concisely.
Context: <CONTEXT>

Format (plain text only):
● Part of Speech: xxx /American English IPA/
● Word Roots: xxx
● Definition: xxx
● Context Meaning:
● Collocations: xxx`
	} else {
		promptTemplate = s.GetConfig().PromptTemplate
	}

	if contextStr == "" {
		promptTemplate = strings.ReplaceAll(promptTemplate, "语境：<CONTEXT>", "")
		promptTemplate = strings.ReplaceAll(promptTemplate, "● 语境释义：", "")
		promptTemplate = strings.ReplaceAll(promptTemplate, "\nContext: <CONTEXT>", "")
		promptTemplate = strings.ReplaceAll(promptTemplate, "● Context Meaning:", "")
	}

	prompt := promptTemplate
	prompt = strings.ReplaceAll(prompt, "<WORD>", word)
	prompt = strings.ReplaceAll(prompt, "<CONTEXT>", contextStr)
	return prompt
}

// parseExplanation parses structured Ollama explanation into a dictionary entry
func (s *Service) parseExplanation(word, explanation string) *DictionaryEntry {
	// Clean up the explanation text
	cleanExplanation := s.cleanExplanationText(explanation)

	// Try to parse structured content
	pronunciation, partOfSpeech, meaning, usageNote, morphology, examples := s.parseStructuredExplanation(cleanExplanation)

	// Build the complete meaning text
	completeMeaning := meaning
	if usageNote != "" {
		completeMeaning += "\n" + usageNote
	}
	if len(examples) > 0 {
		completeMeaning += "\n" + strings.Join(examples, "\n")
	}

	entry := &DictionaryEntry{
		Word: word,
		Definitions: []DictionaryDefinition{
			{
				PartOfSpeech: partOfSpeech,
				Meaning:      completeMeaning,
			},
		},
		Morphology: morphology,
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
func (s *Service) parseStructuredExplanation(text string) (pronunciation, partOfSpeech, meaning, usageNote, morphology string, examples []string) {
	lines := strings.Split(text, "\n")

	currentSection := ""
	var exampleLines []string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Parse structured sections
		//nolint:gocritic
		if strings.HasPrefix(line, "● 词性：") || strings.HasPrefix(line, "● 词性:") || strings.HasPrefix(line, "● Part of Speech:") {
			posContent := line
			posContent = strings.TrimPrefix(posContent, "● 词性：")
			posContent = strings.TrimPrefix(posContent, "● 词性:")
			posContent = strings.TrimPrefix(posContent, "● Part of Speech:")
			posContent = strings.TrimSpace(posContent)

			// Extract pronunciation embedded in 词性 line (e.g., "名词 /'kɑn,tekst/")
			if slashIdx := strings.Index(posContent, "/"); slashIdx >= 0 {
				partOfSpeech = strings.TrimSpace(posContent[:slashIdx])
				lastSlashIdx := strings.LastIndex(posContent, "/")
				if lastSlashIdx > slashIdx {
					pronunciation = strings.TrimSpace(posContent[slashIdx+1 : lastSlashIdx])
				}
			} else {
				partOfSpeech = posContent
			}
			currentSection = "pos"

		} else if strings.HasPrefix(line, "● 词根拆解：") || strings.HasPrefix(line, "● 词根拆解:") || strings.HasPrefix(line, "● Word Roots:") {
			morphology = line
			morphology = strings.TrimPrefix(morphology, "● 词根拆解：")
			morphology = strings.TrimPrefix(morphology, "● 词根拆解:")
			morphology = strings.TrimPrefix(morphology, "● Word Roots:")
			morphology = strings.TrimSpace(morphology)
			currentSection = "morphology"

		} else if strings.HasPrefix(line, "● 释义：") || strings.HasPrefix(line, "● 释义:") || strings.HasPrefix(line, "● Definition:") {
			meaning = line
			meaning = strings.TrimPrefix(meaning, "● 释义：")
			meaning = strings.TrimPrefix(meaning, "● 释义:")
			meaning = strings.TrimPrefix(meaning, "● Definition:")
			meaning = strings.TrimSpace(meaning)
			currentSection = "meaning"

		} else if strings.HasPrefix(line, "● 语境释义：") || strings.HasPrefix(line, "● 语境释义:") || strings.HasPrefix(line, "● Context Meaning:") {
			usageNote = line
			usageNote = strings.TrimPrefix(usageNote, "● 语境释义：")
			usageNote = strings.TrimPrefix(usageNote, "● 语境释义:")
			usageNote = strings.TrimPrefix(usageNote, "● Context Meaning:")
			usageNote = strings.TrimSpace(usageNote)
			currentSection = "usage"

		} else if strings.HasPrefix(line, "● 常见搭配：") || strings.HasPrefix(line, "● 常见搭配:") || strings.HasPrefix(line, "● Collocations:") {
			exampleText := line
			exampleText = strings.TrimPrefix(exampleText, "● 常见搭配：")
			exampleText = strings.TrimPrefix(exampleText, "● 常见搭配:")
			exampleText = strings.TrimPrefix(exampleText, "● Collocations:")
			exampleText = strings.TrimSpace(exampleText)
			if exampleText != "" {
				exampleLines = append(exampleLines, exampleText)
			}
			currentSection = "collocations"

		} else if currentSection == "meaning" && meaning != "" {
			meaning += " " + line
		} else if currentSection == "usage" && usageNote != "" {
			usageNote += " " + line
		} else if currentSection == "collocations" {
			// Handle example/collocation lines
			if strings.HasPrefix(line, "-") || strings.HasPrefix(line, "•") || strings.HasPrefix(line, "1.") || strings.HasPrefix(line, "2.") {
				cleaned := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(line, "-"), "•"), "1."))
				cleaned = strings.TrimSpace(strings.TrimPrefix(cleaned, "2."))
				if cleaned != "" {
					exampleLines = append(exampleLines, cleaned)
				}
			} else if line != "" && !strings.HasPrefix(line, "● ") {
				exampleLines = append(exampleLines, line)
			}
		}

		// Fallback: if no structured format detected, treat as meaning
		if partOfSpeech == "" && meaning == "" && usageNote == "" && len(exampleLines) == 0 {
			if !strings.HasPrefix(line, "● ") && !strings.Contains(line, "###") && !strings.Contains(line, "---") {
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

	return pronunciation, partOfSpeech, meaning, usageNote, morphology, examples
}
