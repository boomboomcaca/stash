import { DictionaryEntry } from './types';
import { ollamaBackendService } from './ollamaBackendService';

// Dictionary service for word lookups
export class DictionaryService {
  private cache = new Map<string, DictionaryEntry>();
  private ollamaAvailable = false;

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
      console.log('Ollama backend service availability:', this.ollamaAvailable);
    } catch (error) {
      console.warn('Failed to check Ollama availability:', error);
      this.ollamaAvailable = false;
    }
  }

  // Look up a word in the dictionary (without context)
  async lookup(word: string, language: string = 'en'): Promise<DictionaryEntry | null> {
    return this.lookupWithContext(word, '', language);
  }

  // Look up a word with context using Ollama if available, fallback to traditional APIs
  async lookupWithContext(word: string, context: string = '', language: string = 'en'): Promise<DictionaryEntry | null> {
    const cacheKey = context 
      ? `${word.toLowerCase()}_${language}_${context.slice(0, 50)}` // Include context in cache key
      : `${word.toLowerCase()}_${language}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      let entry: DictionaryEntry | null = null;

      // Only use Ollama for word lookup - no fallback to traditional APIs
      if (this.ollamaAvailable) {
        try {
          console.log('🤖 Using Ollama backend for word explanation:', { word, context });
          const backendEntry = await ollamaBackendService.explainWord(word, context, language);
          
          // Convert backend format to local format
          entry = {
            word: backendEntry.word,
            pronunciation: undefined, // Backend doesn't provide pronunciation yet
            definitions: backendEntry.definitions.map(def => ({
              partOfSpeech: def.partOfSpeech,
              meaning: def.meaning,
              examples: def.examples
            })),
            etymology: backendEntry.etymology
          };
          
          console.log('🤖 Ollama backend response:', entry);
        } catch (error) {
          console.warn('Ollama backend lookup failed:', error);
          entry = this.createBasicEntry(word, language, 'Ollama服务暂时不可用');
        }
      } else {
        console.warn('Ollama backend service not available');
        entry = this.createBasicEntry(word, language, 'Ollama服务未启用');
      }

      // Cache the result
      if (entry) {
        this.cache.set(cacheKey, entry);
      }

      return entry;
    } catch (error) {
      console.warn('Dictionary lookup failed:', error);
      return this.createBasicEntry(word, language, '查词失败');
    }
  }

  // Traditional APIs removed - only using Ollama backend service

  // Create basic entry when API fails
  private createBasicEntry(word: string, language: string, reason: string = 'Definition not available'): DictionaryEntry {
    return {
      word,
      definitions: [{
        partOfSpeech: 'unknown',
        meaning: `${word} (${language}) - ${reason}`,
        examples: []
      }]
    };
  }

  // Initialize cache with common words for better UX
  private initializeCommonWords() {
    const commonWords = [
      {
        word: 'the',
        definitions: [{
          partOfSpeech: 'article',
          meaning: 'Used to refer to a specific thing or person',
          examples: ['The cat is sleeping']
        }]
      },
      {
        word: 'is',
        definitions: [{
          partOfSpeech: 'verb',
          meaning: 'Third person singular present of "be"',
          examples: ['She is happy']
        }]
      },
      {
        word: 'and',
        definitions: [{
          partOfSpeech: 'conjunction',
          meaning: 'Used to connect words or phrases',
          examples: ['Bread and butter']
        }]
      },
      // Add more common words as needed
    ];

    commonWords.forEach(word => {
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
      keys: Array.from(this.cache.keys())
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
    return await ollamaBackendService.getStatus();
  }
}

// Singleton instance
export const dictionaryService = new DictionaryService();

// Helper function for quick lookup (without context)
export async function lookupWord(word: string, language: string = 'en'): Promise<DictionaryEntry | null> {
  return dictionaryService.lookup(word, language);
}

// Helper function for contextual lookup using Ollama
export async function lookupWordWithContext(
  word: string, 
  context: string, 
  language: string = 'en'
): Promise<DictionaryEntry | null> {
  return dictionaryService.lookupWithContext(word, context, language);
}
