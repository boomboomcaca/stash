// Configuration for Ollama service integration

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeout: number;
  enabled: boolean;
  fallbackToTraditionalDict: boolean;
  promptTemplate: string;
}

// Default configuration
export const defaultOllamaConfig: OllamaConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:latest',
  timeout: 30000,
  enabled: true,
  fallbackToTraditionalDict: true,
  promptTemplate: '解释: 请解释一下这句话中这个词的用法<WORD>： <CONTEXT>\n\n请用中文回答，包含以下信息：\n1. 词性\n2. 在此上下文中的含义\n3. 使用示例（如果适用）\n\n请保持回答简洁明了。'
};

// Configuration manager
export class OllamaConfigManager {
  private static readonly STORAGE_KEY = 'stash_ollama_config';
  private config: OllamaConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  // Load configuration from localStorage
  private loadConfig(): OllamaConfig {
    try {
      const stored = localStorage.getItem(OllamaConfigManager.STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...defaultOllamaConfig, ...parsed };
      }
    } catch (error) {
      console.warn('Failed to load Ollama config from storage:', error);
    }
    return { ...defaultOllamaConfig };
  }

  // Save configuration to localStorage
  private saveConfig(): void {
    try {
      localStorage.setItem(OllamaConfigManager.STORAGE_KEY, JSON.stringify(this.config));
    } catch (error) {
      console.warn('Failed to save Ollama config to storage:', error);
    }
  }

  // Get current configuration
  getConfig(): OllamaConfig {
    return { ...this.config };
  }

  // Update configuration
  updateConfig(updates: Partial<OllamaConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  // Reset to default configuration
  resetConfig(): void {
    this.config = { ...defaultOllamaConfig };
    this.saveConfig();
  }

  // Validate configuration
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate URL
    try {
      new URL(this.config.baseUrl);
    } catch {
      errors.push('Invalid base URL format');
    }

    // Validate timeout
    if (this.config.timeout < 1000 || this.config.timeout > 120000) {
      errors.push('Timeout must be between 1000ms and 120000ms');
    }

    // Validate model name
    if (!this.config.model || this.config.model.trim().length === 0) {
      errors.push('Model name cannot be empty');
    }

    // Validate prompt template
    if (!this.config.promptTemplate.includes('<WORD>') || !this.config.promptTemplate.includes('<CONTEXT>')) {
      errors.push('Prompt template must include <WORD> and <CONTEXT> placeholders');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // Build prompt from template
  buildPrompt(word: string, context: string): string {
    return this.config.promptTemplate
      .replace('<WORD>', word)
      .replace('<CONTEXT>', context);
  }

  // Get model list URL
  getModelsUrl(): string {
    return `${this.config.baseUrl}/api/tags`;
  }

  // Get generate URL
  getGenerateUrl(): string {
    return `${this.config.baseUrl}/api/generate`;
  }

  // Get version URL
  getVersionUrl(): string {
    return `${this.config.baseUrl}/api/version`;
  }
}

// Singleton instance
export const ollamaConfigManager = new OllamaConfigManager();

// Helper functions
export function getOllamaConfig(): OllamaConfig {
  return ollamaConfigManager.getConfig();
}

export function updateOllamaConfig(updates: Partial<OllamaConfig>): void {
  return ollamaConfigManager.updateConfig(updates);
}

export function isOllamaEnabled(): boolean {
  return ollamaConfigManager.getConfig().enabled;
}
