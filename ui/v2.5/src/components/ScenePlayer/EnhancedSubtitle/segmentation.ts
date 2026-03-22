import { IWordSegment, ISegmentationOptions } from "./types";

// Simple word segmentation for different languages
export class WordSegmenter {
  private options: ISegmentationOptions;

  constructor(options: ISegmentationOptions) {
    this.options = options;
  }

  // Segment text into words based on language
  segmentText(text: string): IWordSegment[] {
    switch (this.options.language) {
      case "zh":
      case "zh-CN":
      case "zh-TW":
        return this.segmentChinese(text);
      case "ja":
        return this.segmentJapanese(text);
      case "ko":
        return this.segmentKorean(text);
      default:
        return this.segmentLatin(text);
    }
  }

  // Latin-based languages (English, Spanish, French, etc.)
  private segmentLatin(text: string): IWordSegment[] {
    const segments: IWordSegment[] = [];
    // Use Unicode property escapes to match letters (including accented ones like é, à) and numbers,
    // optionally followed by apostrophes/hyphens inside the word.
    const wordRegex = /[\p{L}\p{M}\p{N}]+(?:['\-][\p{L}\p{M}\p{N}]+)*/gu;
    let match;

    while ((match = wordRegex.exec(text)) !== null) {
      const word = match[0];
      if (word.length >= this.options.minWordLength) {
        segments.push({
          word,
          startIndex: match.index,
          endIndex: match.index + word.length,
        });
      }
    }

    // Add punctuation if enabled
    if (this.options.enablePunctuation) {
      const punctRegex = /[.,;:!?'"()[\]{}]/g;
      while ((match = punctRegex.exec(text)) !== null) {
        segments.push({
          word: match[0],
          startIndex: match.index,
          endIndex: match.index + 1,
        });
      }
    }

    // Sort by start index
    return segments.sort((a, b) => a.startIndex - b.startIndex);
  }

  // Chinese segmentation (simplified approach)
  private segmentChinese(text: string): IWordSegment[] {
    const segments: IWordSegment[] = [];

    // For now, treat each character as a word
    // In a real implementation, you'd use a library like jieba or nodejieba
    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Skip whitespace and punctuation unless enabled
      if (char.trim() === "") continue;

      const isPunctuation = /[，。！？；：""''（）【】《》]/u.test(char);
      if (isPunctuation && !this.options.enablePunctuation) continue;

      // Check if it's a Chinese character or punctuation
      if (/[\u4e00-\u9fff]|[，。！？；：""''（）【】《》]/u.test(char)) {
        segments.push({
          word: char,
          startIndex: i,
          endIndex: i + 1,
        });
      }
    }

    return segments;
  }

  // Japanese segmentation (simplified approach)
  private segmentJapanese(text: string): IWordSegment[] {
    const segments: IWordSegment[] = [];

    // This is a very simplified approach
    // In a real implementation, you'd use MeCab or similar
    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char.trim() === "") continue;

      const isPunctuation = /[、。！？；：「」『』（）]/u.test(char);
      if (isPunctuation && !this.options.enablePunctuation) continue;

      // Check if it's a Japanese character
      if (
        /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]|[、。！？；：「」『』（）]/u.test(
          char
        )
      ) {
        segments.push({
          word: char,
          startIndex: i,
          endIndex: i + 1,
        });
      }
    }

    return segments;
  }

  // Korean segmentation (simplified approach)
  private segmentKorean(text: string): IWordSegment[] {
    const segments: IWordSegment[] = [];

    // Space-based segmentation for Korean
    const words = text.split(/(\s+)/);
    let currentIndex = 0;

    for (const word of words) {
      if (word.trim() && word.length >= this.options.minWordLength) {
        // Check if it contains Korean characters
        if (/[\uac00-\ud7af]/u.test(word)) {
          segments.push({
            word: word.trim(),
            startIndex: currentIndex,
            endIndex: currentIndex + word.trim().length,
          });
        }
      }
      currentIndex += word.length;
    }

    return segments;
  }
}

// Factory function to create segmenter
export function createSegmenter(
  options: Partial<ISegmentationOptions> = {}
): WordSegmenter {
  const defaultOptions: ISegmentationOptions = {
    language: "en",
    enablePunctuation: false,
    minWordLength: 1,
  };

  return new WordSegmenter({ ...defaultOptions, ...options });
}

// Utility function to detect language from text
export function detectLanguage(text: string): string {
  // Simple language detection based on character ranges
  if (/[\u4e00-\u9fff]/.test(text)) {
    return "zh";
  } else if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) {
    return "ja";
  } else if (/[\uac00-\ud7af]/.test(text)) {
    return "ko";
  } else if (/[а-яё]/i.test(text)) {
    return "ru";
  } else if (/[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/i.test(text)) {
    return "fr";
  } else if (/[äöüß]/i.test(text)) {
    return "de";
  } else if (/[ñ¿¡]/i.test(text)) {
    return "es";
  }

  return "en"; // Default to English
}
