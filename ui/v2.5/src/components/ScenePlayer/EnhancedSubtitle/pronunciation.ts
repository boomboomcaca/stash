// Text-to-Speech service for word pronunciation
// Uses backend Edge TTS proxy to avoid CORS issues and support mobile browsers

export interface ITTSProvider {
  name: string;
  getAudioUrl(word: string, language: string): string;
}

// Backend TTS Provider (proxies Microsoft Edge TTS through our server)
class BackendTTSProvider implements ITTSProvider {
  name = "Backend Edge TTS Proxy";

  getAudioUrl(word: string, language: string): string {
    // Use our backend proxy endpoint
    // This works on both desktop and mobile browsers
    const encodedText = encodeURIComponent(word);
    const encodedLang = encodeURIComponent(language);
    return `/tts/pronounce?text=${encodedText}&lang=${encodedLang}`;
  }
}

// Browser Speech Synthesis Provider (fallback for when backend is unavailable)
class BrowserTTSProvider implements ITTSProvider {
  name = "Browser Speech Synthesis";
  private synth: SpeechSynthesis | null = null;

  constructor() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      this.synth = window.speechSynthesis;
    }
  }

  getAudioUrl(): string {
    // Browser TTS doesn't use URLs, handled separately in playPronunciation
    return "";
  }

  canUse(): boolean {
    return this.synth !== null;
  }

  speak(text: string, language: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.synth) {
        reject(new Error("Speech synthesis not supported"));
        return;
      }

      // Cancel any ongoing speech
      this.synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);

      // Map language codes
      const langMap: Record<string, string> = {
        zh: "zh-CN",
        en: "en-US",
        es: "es-ES",
        fr: "fr-FR",
        de: "de-DE",
        ja: "ja-JP",
        ko: "ko-KR",
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
  private provider: ITTSProvider;
  private browserProvider: BrowserTTSProvider;
  private audioCache = new Map<string, HTMLAudioElement>();
  private useBackend = true; // Prefer backend by default
  // ✅ 添加最大缓存大小限制
  private readonly MAX_CACHE_SIZE = 50; // 最多缓存50个音频
  private readonly CACHE_CLEANUP_THRESHOLD = 40; // 当缓存达到40个时开始清理

  constructor() {
    // Use backend TTS proxy (works on all platforms)
    this.provider = new BackendTTSProvider();
    this.browserProvider = new BrowserTTSProvider();
  }

  // ✅ 添加缓存清理方法
  private cleanupCache(): void {
    if (this.audioCache.size >= this.CACHE_CLEANUP_THRESHOLD) {
      // 清理最旧的缓存项（Map保持插入顺序）
      const entriesToRemove = this.audioCache.size - this.MAX_CACHE_SIZE;
      const keysToRemove = Array.from(this.audioCache.keys()).slice(
        0,
        entriesToRemove
      );

      for (const key of keysToRemove) {
        const audio = this.audioCache.get(key);
        if (audio) {
          // 清理音频资源
          audio.pause();
          audio.src = "";
          audio.load(); // 释放资源
        }
        this.audioCache.delete(key);
      }
    }
  }

  // Get pronunciation URL for a word
  getPronunciationUrl(word: string, language: string = "en"): string {
    return this.provider.getAudioUrl(word, language);
  }

  // Preload pronunciation for a word (fetch without playing)
  preloadPronunciation(word: string, language: string = "en"): void {
    if (!this.useBackend) return;

    const cacheKey = `${word}_${language}`;
    if (this.audioCache.has(cacheKey)) return;

    // Check cache size and cleanup if needed
    if (this.audioCache.size >= this.MAX_CACHE_SIZE) {
      this.cleanupCache();
    }

    const url = this.getPronunciationUrl(word, language);
    const audio = new Audio(url);
    audio.onerror = () => {
      this.audioCache.delete(cacheKey);
    };
    audio.oncanplaythrough = () => {
      // Preloaded successfully
    };
    // Trigger load explicitly
    audio.load();

    this.audioCache.set(cacheKey, audio);
  }

  // Play pronunciation for a word
  async playPronunciation(
    word: string,
    language: string = "en"
  ): Promise<void> {
    try {
      if (this.useBackend) {
        await this.playWithBackend(word, language);
      } else if (this.browserProvider.canUse()) {
        await this.browserProvider.speak(word, language);
      } else {
        throw new Error("No TTS provider available");
      }
    } catch (error) {
      console.error("Backend TTS failed, trying browser fallback:");
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
        this.cleanupCache();
      }

      // Create new audio element
      const url = this.getPronunciationUrl(word, language);
      audio = new Audio(url);

      // Add error handler
      audio.onerror = () => {
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
    } catch (error) {
      // Remove from cache if playback fails
      this.audioCache.delete(cacheKey);
      throw error;
    }
  }

  // Stop all playing audio
  stopAll(): void {
    // Stop HTML5 audio
    this.audioCache.forEach((audio) => {
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
      audio.src = "";
      audio.load(); // 释放资源
    });
    this.audioCache.clear();
  }

  // Get cache size
  getCacheSize(): number {
    return this.audioCache.size;
  }

  // Toggle between backend and browser TTS
  setUseBackend(useBackend: boolean): void {
    this.useBackend = useBackend;
  }
}

// Singleton instance
export const pronunciationService = new PronunciationService();

// Helper function for quick pronunciation playback
export async function playWordPronunciation(
  word: string,
  language: string = "en"
): Promise<void> {
  return pronunciationService.playPronunciation(word, language);
}

// Helper function to get pronunciation URL
export function getPronunciationUrl(
  word: string,
  language: string = "en"
): string {
  return pronunciationService.getPronunciationUrl(word, language);
}

// Helper function to preload pronunciation
export function preloadWordPronunciation(
  word: string,
  language: string = "en"
): void {
  pronunciationService.preloadPronunciation(word, language);
}
