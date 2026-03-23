package api

import (
	"context"

	"github.com/stashapp/stash/pkg/ollama"
)

// ConfigureOllama configures the Ollama service settings
func (r *mutationResolver) ConfigureOllama(ctx context.Context, input OllamaConfigInput) (*OllamaConfig, error) {
	config := &ollama.OllamaConfig{
		BaseURL:                   input.BaseURL,
		Model:                     input.Model,
		Timeout:                   input.Timeout,
		Enabled:                   input.Enabled,
		FallbackToTraditionalDict: input.FallbackToTraditionalDict,
		PromptTemplate:            input.PromptTemplate,
	}
	if input.MistralAPIKey != nil {
		config.MistralAPIKey = *input.MistralAPIKey
	}

	ollamaService := r.getOllamaService()
	ollamaService.UpdateConfig(config)

	// Save configuration to database/config store if needed
	// This might need to be stored in the configuration system
	if err := r.saveOllamaConfig(config); err != nil {
		return nil, err
	}

	return &OllamaConfig{
		BaseURL:                   config.BaseURL,
		Model:                     config.Model,
		Timeout:                   config.Timeout,
		Enabled:                   config.Enabled,
		FallbackToTraditionalDict: config.FallbackToTraditionalDict,
		PromptTemplate:            config.PromptTemplate,
		MistralAPIKey:             &config.MistralAPIKey,
	}, nil
}

// OllamaGenerate generates text using Ollama
func (r *mutationResolver) OllamaGenerate(ctx context.Context, input OllamaGenerateInput) (*OllamaGenerateResult, error) {
	ollamaService := r.getOllamaService()

	model := input.Model
	if model == nil {
		model = &ollamaService.GetConfig().Model
	}

	response, err := ollamaService.Generate(ctx, input.Prompt, *model)
	if err != nil {
		return nil, err
	}

	return &OllamaGenerateResult{
		Response: response,
		Model:    *model,
		// TotalDuration and EvalCount could be added if we enhance the service to return them
	}, nil
}

// OllamaExplainWord explains a word in context using Ollama
func (r *mutationResolver) OllamaExplainWord(ctx context.Context, input OllamaExplainWordInput) (*OllamaDictionaryEntry, error) {
	ollamaService := r.getOllamaService()

	language := "en"
	if input.Language != nil {
		language = *input.Language
	}

	var provider string
	if input.Provider != nil {
		provider = *input.Provider
	}

	entry, err := ollamaService.ExplainWord(ctx, input.Word, input.Context, language, provider)
	if err != nil {
		return nil, err
	}

	// Convert to GraphQL types
	definitions := make([]*OllamaDictionaryDefinition, len(entry.Definitions))
	for i, def := range entry.Definitions {
		definitions[i] = &OllamaDictionaryDefinition{
			PartOfSpeech: def.PartOfSpeech,
			Meaning:      def.Meaning,
			Examples:     def.Examples,
		}
	}

	return &OllamaDictionaryEntry{
		Word:          entry.Word,
		Pronunciation: &entry.Pronunciation,
		Definitions:   definitions,
		Etymology:     entry.Etymology,
		Morphology:    &entry.Morphology,
		AiSource:      &entry.AISource,
	}, nil
}
