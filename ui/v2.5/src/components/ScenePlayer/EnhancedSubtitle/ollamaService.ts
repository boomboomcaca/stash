import { DictionaryEntry } from './types';
import { ollamaConfigManager } from './ollamaConfig';

export interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: {
    temperature?: number;
    top_k?: number;
    top_p?: number;
  };
}

export class OllamaService {
  constructor() {
    // Configuration is now managed by ollamaConfigManager
  }

  // Get current configuration
  private getConfig() {
    return ollamaConfigManager.getConfig();
  }

  // Test if Ollama service is available
  async isAvailable(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.enabled) {
      return false;
    }

    try {
      const response = await fetch(ollamaConfigManager.getVersionUrl(), {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout for availability check
      });
      return response.ok;
    } catch (error) {
      console.warn('Ollama service not available:', error);
      return false;
    }
  }

  // Get available models
  async getModels(): Promise<string[]> {
    try {
      const response = await fetch(ollamaConfigManager.getModelsUrl(), {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data.models?.map((model: any) => model.name) || [];
    } catch (error) {
      console.error('Failed to get Ollama models:', error);
      return [];
    }
  }

  // Generate completion from Ollama
  async generate(prompt: string, model?: string): Promise<string> {
    const config = this.getConfig();
    
    const requestBody: OllamaRequest = {
      model: model || config.model,
      prompt,
      stream: false,
      options: {
        temperature: 0.3, // Lower temperature for more consistent explanations
        top_k: 40,
        top_p: 0.9,
      },
    };

    try {
      const response = await fetch(ollamaConfigManager.getGenerateUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(config.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: OllamaResponse = await response.json();
      return data.response || '';
    } catch (error) {
      console.error('Ollama generation failed:', error);
      throw error;
    }
  }

  // Explain a word in context using Ollama
  async explainWord(word: string, context: string, language: string = 'en'): Promise<DictionaryEntry> {
    const prompt = ollamaConfigManager.buildPrompt(word, context);

    try {
      const explanation = await this.generate(prompt);
      
      // Parse the response to create a DictionaryEntry
      return this.parseExplanation(word, explanation);
    } catch (error) {
      console.error('Failed to explain word with Ollama:', error);
      throw error;
    }
  }

  // Parse Ollama explanation into DictionaryEntry format
  private parseExplanation(word: string, explanation: string): DictionaryEntry {
    const lines = explanation.split('\n').filter(line => line.trim());
    
    let partOfSpeech = 'unknown';
    let meaning = explanation;
    const examples: string[] = [];

    // Try to extract structured information
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Look for part of speech indicators
      if (trimmedLine.includes('词性') || trimmedLine.includes('：')) {
        const match = trimmedLine.match(/词性[：:]\s*(.+)|^(\d+\.?\s*)?(.+)[：:]\s*(.+)/);
        if (match) {
          partOfSpeech = match[1] || match[4] || 'unknown';
        }
      }
      
      // Look for examples
      if (trimmedLine.includes('示例') || trimmedLine.includes('例子') || trimmedLine.includes('例：')) {
        const exampleMatch = trimmedLine.match(/(?:示例|例子|例)[：:]\s*(.+)/);
        if (exampleMatch) {
          examples.push(exampleMatch[1]);
        }
      }
    }

    // If we couldn't parse structure, use the whole explanation as meaning
    if (meaning === explanation) {
      // Try to extract the main meaning part
      const meaningMatch = explanation.match(/含义[：:]\s*([^。\n]+)/);
      if (meaningMatch) {
        meaning = meaningMatch[1];
      } else {
        // Use first substantial line as meaning
        const substantialLine = lines.find(line => 
          line.trim().length > 10 && 
          !line.includes('词性') && 
          !line.includes('示例')
        );
        if (substantialLine) {
          meaning = substantialLine.trim();
        }
      }
    }

    return {
      word,
      definitions: [{
        partOfSpeech: partOfSpeech.trim(),
        meaning: meaning.trim(),
        examples: examples.filter(ex => ex.trim().length > 0)
      }],
      etymology: `AI解释 (Ollama)`, // Mark as AI-generated explanation
    };
  }

  // Get current configuration (delegated to config manager)
  getConfig() {
    return ollamaConfigManager.getConfig();
  }
}

// Singleton instance
export const ollamaService = new OllamaService();
