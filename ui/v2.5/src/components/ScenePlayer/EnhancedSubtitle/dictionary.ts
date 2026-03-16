import { IDictionaryEntry } from "./types";
import { ollamaBackendService } from "./ollamaBackendService";

// Dictionary service for word lookups
export class DictionaryService {
  private cache = new Map<string, IDictionaryEntry>();
  private ollamaAvailable = false;
  // ✅ 添加最大缓存大小限制
  private readonly MAX_CACHE_SIZE = 100; // 最多缓存100个词条

  constructor() {
    // Initialize with some common words for demonstration
    this.initializeCommonWords();
    // Check if Ollama is available
    this.checkOllamaAvailability();
  }

  // Check if Ollama service is available
  private async checkOllamaAvailability() {
    try {
      this.ollamaAvailable = await ollamaBackendService.isAvailable();
    } catch (error) {
      // console.warn('Failed to check Ollama availability:', error);
      this.ollamaAvailable = false;
    }
  }

  // Look up a word in the dictionary (without context)
  async lookup(
    word: string,
    language: string = "en"
  ): Promise<IDictionaryEntry | null> {
    return this.lookupWithContext(word, "", language);
  }

  // Look up a word with context using Ollama if available, fallback to traditional APIs
  async lookupWithContext(
    word: string,
    context: string = "",
    language: string = "en",
    provider?: string
  ): Promise<IDictionaryEntry | null> {
    const cacheKey = context
      ? `${word.toLowerCase()}_${language}_${context.slice(0, 50)}_${
          provider || "auto"
        }` // Include context and provider in cache key
      : `${word.toLowerCase()}_${language}_${provider || "auto"}`;

    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      let entry: IDictionaryEntry | null = null;

      // Allow calling backend for both Ollama and Gemini
      if (this.ollamaAvailable || provider === "groq") {
        try {
          const backendEntry = await ollamaBackendService.explainWord(
            word,
            context,
            language,
            undefined,
            provider
          );

          // Convert backend format to local format
          entry = {
            word: backendEntry.word,
            pronunciation: backendEntry.pronunciation,
            definitions: backendEntry.definitions.map((def) => ({
              partOfSpeech: def.partOfSpeech,
              meaning: def.meaning,
              examples: def.examples,
            })),
            etymology: backendEntry.etymology,
            morphology: backendEntry.morphology,
            aiSource: backendEntry.aiSource,
          };
        } catch (error) {
          // console.warn('Ollama backend lookup failed:', error);
          const providerName = provider === "groq" ? "Groq" : "Ollama";
          entry = this.createBasicEntry(
            word,
            language,
            `${providerName}服务暂时不可用`
          );
        }
      } else {
        const providerName = provider === "groq" ? "Groq" : "Ollama";
        entry = this.createBasicEntry(
          word,
          language,
          `${providerName}服务未启用`
        );
      }

      // ✅ Cache the result with size limit
      if (entry) {
        // 检查缓存大小，如果超过限制则清理最旧的条目（保留常用词）
        if (this.cache.size >= this.MAX_CACHE_SIZE) {
          // 找到第一个非常用词的条目并删除
          for (const key of this.cache.keys()) {
            // 保留常用词（the, is, and 等）
            if (
              !key.startsWith("the_") &&
              !key.startsWith("is_") &&
              !key.startsWith("and_")
            ) {
              this.cache.delete(key);
              break;
            }
          }
        }
        this.cache.set(cacheKey, entry);
      }

      return entry;
    } catch (error) {
      return this.createBasicEntry(word, language, "查词失败");
    }
  }

  // Get from cache synchronously
  getCachedEntry(
    word: string,
    context: string = "",
    language: string = "en",
    provider?: string
  ): IDictionaryEntry | null {
    const cacheKey = context
      ? `${word.toLowerCase()}_${language}_${context.slice(0, 50)}_${
          provider || "auto"
        }`
      : `${word.toLowerCase()}_${language}_${provider || "auto"}`;
    return this.cache.get(cacheKey) || null;
  }

  // Traditional APIs removed - only using Ollama backend service

  // Create basic entry when API fails
  private createBasicEntry(
    word: string,
    language: string,
    reason: string = "Definition not available"
  ): IDictionaryEntry {
    return {
      word,
      definitions: [
        {
          partOfSpeech: "unknown",
          meaning: `${word} (${language}) - ${reason}`,
          examples: [],
        },
      ],
    };
  }

  // Initialize cache with common words for better UX
  private initializeCommonWords() {
    const commonWords = [
      {
        word: "the",
        definitions: [
          {
            partOfSpeech: "article",
            meaning: "Used to refer to a specific thing or person",
            examples: ["The cat is sleeping"],
          },
        ],
      },
      {
        word: "is",
        definitions: [
          {
            partOfSpeech: "verb",
            meaning: 'Third person singular present of "be"',
            examples: ["She is happy"],
          },
        ],
      },
      {
        word: "and",
        definitions: [
          {
            partOfSpeech: "conjunction",
            meaning: "Used to connect words or phrases",
            examples: ["Bread and butter"],
          },
        ],
      },
      // Add more common words as needed
    ];

    commonWords.forEach((word) => {
      this.cache.set(`${word.word}_en`, word);
    });
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
    this.initializeCommonWords();
  }

  // Get cache statistics
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  // Get Ollama availability status
  isOllamaAvailable(): boolean {
    return this.ollamaAvailable;
  }

  // Force refresh Ollama availability
  async refreshOllamaAvailability(): Promise<boolean> {
    await this.checkOllamaAvailability();
    return this.ollamaAvailable;
  }

  // Get Ollama service status
  async getOllamaStatus() {
    return ollamaBackendService.getStatus();
  }
}

// Singleton instance
export const dictionaryService = new DictionaryService();

// Helper function for quick lookup (without context)
export async function lookupWord(
  word: string,
  language: string = "en",
  provider?: string
): Promise<IDictionaryEntry | null> {
  return dictionaryService.lookupWithContext(word, "", language, provider);
}

// Helper function for contextual lookup using Ollama
export async function lookupWordWithContext(
  word: string,
  context: string,
  language: string = "en",
  provider?: string
): Promise<IDictionaryEntry | null> {
  return dictionaryService.lookupWithContext(word, context, language, provider);
}

// Helper function to get cached word synchronously
export function getCachedWord(
  word: string,
  context: string = "",
  language: string = "en",
  provider?: string
): IDictionaryEntry | null {
  return dictionaryService.getCachedEntry(word, context, language, provider);
}
