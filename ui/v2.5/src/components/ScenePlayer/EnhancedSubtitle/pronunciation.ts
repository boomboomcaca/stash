// Text-to-Speech service for word pronunciation
// Uses backend proxy to avoid CORS issues and support mobile browsers

export interface TTSProvider {
  name: string;
  getAudioUrl(word: string, language: string): string;
}

// Backend TTS Provider (proxies Google TTS through our server)
class BackendTTSProvider implements TTSProvider {
  name = 'Backend TTS Proxy';

  getAudioUrl(word: string, language: string): string {
    // Use our backend proxy endpoint
    // This works on both desktop and mobile browsers
    const encodedText = encodeURIComponent(word);
    const encodedLang = encodeURIComponent(language);
    return `/tts/pronounce?text=${encodedText}&lang=${encodedLang}`;
  }
}

// Browser Speech Synthesis Provider (fallback for when backend is unavailable)
class BrowserTTSProvider implements TTSProvider {
  name = 'Browser Speech Synthesis';
  private synth: SpeechSynthesis | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
    }
  }

  getAudioUrl(word: string, language: string): string {
    // Browser TTS doesn't use URLs, handled separately in playPronunciation
    return '';
  }

  canUse(): boolean {
    return this.synth !== null;
  }

  speak(text: string, language: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.synth) {
        reject(new Error('Speech synthesis not supported'));
        return;
      }

      // Cancel any ongoing speech
      this.synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      
      // Map language codes
      const langMap: Record<string, string> = {
        'zh': 'zh-CN',
        'en': 'en-US',
        'es': 'es-ES',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
      };
      
      utterance.lang = langMap[language] || language;
      utterance.rate = 0.9; // Slightly slower for clarity
      utterance.pitch = 1.0;

      utterance.onend = () => resolve();
      utterance.onerror = (event) => reject(event.error);

      this.synth.speak(utterance);
    });
  }
}

// Pronunciation Service
export class PronunciationService {
  private provider: TTSProvider;
  private browserProvider: BrowserTTSProvider;
  private audioCache = new Map<string, HTMLAudioElement>();
  private useBackend = true; // Prefer backend by default
  // ✅ 添加最大缓存大小限制
  private readonly MAX_CACHE_SIZE = 50; // 最多缓存50个音频

  constructor() {
    // Use backend TTS proxy (works on all platforms)
    this.provider = new BackendTTSProvider();
    this.browserProvider = new BrowserTTSProvider();
  }

  // Get pronunciation URL for a word
  getPronunciationUrl(word: string, language: string = 'en'): string {
    return this.provider.getAudioUrl(word, language);
  }

  // Play pronunciation for a word
  async playPronunciation(word: string, language: string = 'en'): Promise<void> {
    try {
      if (this.useBackend) {
        await this.playWithBackend(word, language);
      } else if (this.browserProvider.canUse()) {
        await this.browserProvider.speak(word, language);
      } else {
        throw new Error('No TTS provider available');
      }
    } catch (error) {
      console.error('Backend TTS failed, trying browser fallback:', error);
      // Fallback to browser TTS if backend fails
      if (this.browserProvider.canUse()) {
        this.useBackend = false;
        await this.browserProvider.speak(word, language);
      } else {
        throw error;
      }
    }
  }

  private async playWithBackend(word: string, language: string): Promise<void> {
    const cacheKey = `${word}_${language}`;
    
    // Check cache first
    let audio = this.audioCache.get(cacheKey);
    
    if (!audio) {
      // ✅ 检查缓存大小，如果超过限制则清理最旧的条目
      if (this.audioCache.size >= this.MAX_CACHE_SIZE) {
        // 删除第一个（最旧的）条目
        const firstKey = this.audioCache.keys().next().value;
        const oldAudio = this.audioCache.get(firstKey);
        if (oldAudio) {
          // 清理音频资源
          oldAudio.pause();
          oldAudio.src = '';
          oldAudio.load(); // 释放资源
        }
        this.audioCache.delete(firstKey);
        console.log(`🗑️ Pronunciation cache evicted: ${firstKey} (cache size: ${this.audioCache.size})`);
      }
      
      // Create new audio element
      const url = this.getPronunciationUrl(word, language);
      audio = new Audio(url);
      
      // Add error handler
      audio.onerror = (e) => {
        console.error('Audio playback error:', e);
        this.audioCache.delete(cacheKey); // Remove from cache on error
      };
      
      // ✅ 添加结束事件清理
      audio.onended = () => {
        // 播放结束后可以考虑清理（可选）
        // 这里保留在缓存中以便重复播放
      };
      
      // Cache the audio element
      this.audioCache.set(cacheKey, audio);
    }

    // Stop any currently playing audio
    this.stopAll();
    
    // Play the audio
    try {
      await audio.play();
      console.log(`🔊 Playing pronunciation: ${word} (${language})`);
    } catch (error) {
      // Remove from cache if playback fails
      this.audioCache.delete(cacheKey);
      throw error;
    }
  }

  // Stop all playing audio
  stopAll(): void {
    // Stop HTML5 audio
    this.audioCache.forEach(audio => {
      if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
      }
    });

    // Stop browser speech synthesis
    if (this.browserProvider.canUse()) {
      window.speechSynthesis.cancel();
    }
  }

  // Clear audio cache
  clearCache(): void {
    this.stopAll();
    // ✅ 正确清理所有音频资源
    this.audioCache.forEach((audio) => {
      audio.pause();
      audio.src = '';
      audio.load(); // 释放资源
    });
    this.audioCache.clear();
    console.log('🗑️ Pronunciation cache cleared');
  }

  // Get cache size
  getCacheSize(): number {
    return this.audioCache.size;
  }

  // Toggle between backend and browser TTS
  setUseBackend(useBackend: boolean): void {
    this.useBackend = useBackend;
    console.log(`TTS provider: ${useBackend ? 'Backend Proxy' : 'Browser Speech'}`);
  }
}

// Singleton instance
export const pronunciationService = new PronunciationService();

// Helper function for quick pronunciation playback
export async function playWordPronunciation(word: string, language: string = 'en'): Promise<void> {
  return pronunciationService.playPronunciation(word, language);
}

// Helper function to get pronunciation URL
export function getPronunciationUrl(word: string, language: string = 'en'): string {
  return pronunciationService.getPronunciationUrl(word, language);
}

