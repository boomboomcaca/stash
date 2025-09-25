import { getClient } from "src/core/StashService";
import { gql } from "@apollo/client";

// GraphQL queries and mutations for Ollama backend integration
const OLLAMA_STATUS_QUERY = gql`
  query OllamaStatus {
    ollamaStatus {
      available
      config {
        baseUrl
        model
        timeout
        enabled
        fallbackToTraditionalDict
        promptTemplate
      }
      models
      version
    }
  }
`;

const CONFIGURE_OLLAMA_MUTATION = gql`
  mutation ConfigureOllama($input: OllamaConfigInput!) {
    configureOllama(input: $input) {
      baseUrl
      model
      timeout
      enabled
      fallbackToTraditionalDict
      promptTemplate
    }
  }
`;

const OLLAMA_EXPLAIN_WORD_MUTATION = gql`
  mutation OllamaExplainWord($input: OllamaExplainWordInput!) {
    ollamaExplainWord(input: $input) {
      word
      pronunciation
      definitions {
        partOfSpeech
        meaning
        examples
      }
      etymology
    }
  }
`;

const OLLAMA_GENERATE_MUTATION = gql`
  mutation OllamaGenerate($input: OllamaGenerateInput!) {
    ollamaGenerate(input: $input) {
      response
      model
      totalDuration
      evalCount
    }
  }
`;

export interface BackendOllamaConfig {
  baseUrl: string;
  model: string;
  timeout: number;
  enabled: boolean;
  fallbackToTraditionalDict: boolean;
  promptTemplate: string;
}

export interface BackendOllamaStatus {
  available: boolean;
  config: BackendOllamaConfig;
  models: string[];
  version?: string;
}

export interface BackendDictionaryEntry {
  word: string;
  pronunciation?: string;
  definitions: BackendDictionaryDefinition[];
  etymology: string;
}

export interface BackendDictionaryDefinition {
  partOfSpeech: string;
  meaning: string;
  examples: string[];
}

export interface OllamaGenerateResult {
  response: string;
  model: string;
  totalDuration?: number;
  evalCount?: number;
}

/**
 * Backend-integrated Ollama service that uses GraphQL API instead of direct HTTP calls
 */
export class OllamaBackendService {
  private client = getClient();

  constructor() {
    // Using Apollo client directly for GraphQL operations
  }

  /**
   * Get current Ollama status and configuration from backend
   */
  async getStatus(): Promise<BackendOllamaStatus> {
    try {
      const result = await this.client.query({
        query: OLLAMA_STATUS_QUERY,
        fetchPolicy: 'network-only' // Always fetch fresh data
      });
      
      return result.data.ollamaStatus;
    } catch (error) {
      console.error('Failed to get Ollama status:', error);
      throw error;
    }
  }

  /**
   * Check if Ollama service is available through backend
   */
  async isAvailable(): Promise<boolean> {
    try {
      const status = await this.getStatus();
      return status.available;
    } catch (error) {
      console.warn('Failed to check Ollama availability:', error);
      return false;
    }
  }

  /**
   * Get available models from backend
   */
  async getModels(): Promise<string[]> {
    try {
      const status = await this.getStatus();
      return status.models;
    } catch (error) {
      console.error('Failed to get Ollama models:', error);
      return [];
    }
  }

  /**
   * Update Ollama configuration through backend
   */
  async updateConfig(config: BackendOllamaConfig): Promise<BackendOllamaConfig> {
    try {
      const result = await this.client.mutate({
        mutation: CONFIGURE_OLLAMA_MUTATION,
        variables: {
          input: config
        }
      });

      return result.data.configureOllama;
    } catch (error) {
      console.error('Failed to update Ollama config:', error);
      throw error;
    }
  }

  /**
   * Generate text using Ollama through backend
   */
  async generate(prompt: string, model?: string): Promise<OllamaGenerateResult> {
    try {
      const result = await this.client.mutate({
        mutation: OLLAMA_GENERATE_MUTATION,
        variables: {
          input: {
            prompt,
            model: model || undefined
          }
        }
      });

      return result.data.ollamaGenerate;
    } catch (error) {
      console.error('Failed to generate text with Ollama:', error);
      throw error;
    }
  }

  /**
   * Explain a word in context using Ollama through backend
   */
  async explainWord(word: string, context: string, language: string = 'en', model?: string): Promise<BackendDictionaryEntry> {
    try {
      const result = await this.client.mutate({
        mutation: OLLAMA_EXPLAIN_WORD_MUTATION,
        variables: {
          input: {
            word,
            context,
            language,
            model: model || undefined
          }
        }
      });

      return result.data.ollamaExplainWord;
    } catch (error) {
      console.error('Failed to explain word with Ollama:', error);
      throw error;
    }
  }
}

// Singleton instance
export const ollamaBackendService = new OllamaBackendService();
