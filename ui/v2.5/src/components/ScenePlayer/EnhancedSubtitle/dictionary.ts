import { DictionaryEntry } from './types';
import { ollamaService } from './ollamaService';

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
      this.ollamaAvailable = await ollamaService.isAvailable();
      console.log('Ollama service availability:', this.ollamaAvailable);
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

      // If context is provided and Ollama is available, try Ollama first
      if (context && this.ollamaAvailable) {
        try {
          console.log('🤖 Using Ollama for contextual word explanation:', { word, context });
          entry = await ollamaService.explainWord(word, context, language);
          console.log('🤖 Ollama response:', entry);
        } catch (error) {
          console.warn('Ollama lookup failed, falling back to traditional APIs:', error);
          // Continue to fallback methods
        }
      }

      // Fallback to traditional dictionary APIs if Ollama failed or unavailable
      if (!entry) {
        entry = await this.lookupFromFreeDictionary(word, language);
        
        if (!entry && language === 'en') {
          entry = await this.lookupFromWordnik(word);
        }
        
        if (!entry) {
          entry = this.createBasicEntry(word, language);
        }
      }

      // Cache the result
      if (entry) {
        this.cache.set(cacheKey, entry);
      }

      return entry;
    } catch (error) {
      console.warn('Dictionary lookup failed:', error);
      return this.createBasicEntry(word, language);
    }
  }

  // Free Dictionary API lookup
  private async lookupFromFreeDictionary(word: string, language: string): Promise<DictionaryEntry | null> {
    try {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/${language}/${word}`);
      
      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const entry = data[0];

      if (!entry) return null;

      const definitions = entry.meanings?.flatMap((meaning: any) => 
        meaning.definitions?.map((def: any) => ({
          partOfSpeech: meaning.partOfSpeech || 'unknown',
          meaning: def.definition || '',
          examples: def.example ? [def.example] : []
        })) || []
      ) || [];

      return {
        word: entry.word || word,
        pronunciation: entry.phonetic || entry.phonetics?.[0]?.text,
        definitions,
        etymology: entry.etymology,
      };
    } catch (error) {
      return null;
    }
  }

  // Wordnik API lookup (backup)
  private async lookupFromWordnik(word: string): Promise<DictionaryEntry | null> {
    try {
      // This would require an API key in a real implementation
      // For demo purposes, return null
      return null;
    } catch (error) {
      return null;
    }
  }

  // Create basic entry when API fails
  private createBasicEntry(word: string, language: string): DictionaryEntry {
    return {
      word,
      definitions: [{
        partOfSpeech: 'unknown',
        meaning: `Word: ${word} (${language}) - Definition not available`,
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

  // Get Ollama service configuration
  getOllamaConfig() {
    return ollamaService.getConfig();
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
