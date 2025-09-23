import { DictionaryEntry } from './types';

// Dictionary service for word lookups
export class DictionaryService {
  private cache = new Map<string, DictionaryEntry>();

  constructor() {
    // Initialize with some common words for demonstration
    this.initializeCommonWords();
  }

  // Look up a word in the dictionary
  async lookup(word: string, language: string = 'en'): Promise<DictionaryEntry | null> {
    const cacheKey = `${word.toLowerCase()}_${language}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      // Try multiple sources
      let entry = await this.lookupFromFreeDictionary(word, language);
      
      if (!entry && language === 'en') {
        entry = await this.lookupFromWordnik(word);
      }
      
      if (!entry) {
        entry = this.createBasicEntry(word, language);
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
}

// Singleton instance
export const dictionaryService = new DictionaryService();

// Helper function for quick lookup
export async function lookupWord(word: string, language: string = 'en'): Promise<DictionaryEntry | null> {
  return dictionaryService.lookup(word, language);
}
