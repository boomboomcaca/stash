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
    // Match Latin/Greek/Cyrillic letters and numbers (with diacritic marks),
    // explicitly excluding CJK ideographs so bilingual subtitles do not
    // produce Chinese "words" when the cue is segmented as Latin.
    const letterClass =
      "[A-Za-z\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF\\p{M}\\p{N}]";
    const wordRegex = new RegExp(
      `${letterClass}+(?:['\\-]${letterClass}+)*`,
      "gu"
    );
    let match = wordRegex.exec(text);

    while (match !== null) {
      const word = match[0];
      if (word.length >= this.options.minWordLength) {
        segments.push({
          word,
          startIndex: match.index,
          endIndex: match.index + word.length,
        });
      }
      match = wordRegex.exec(text);
    }

    // Add punctuation if enabled
    if (this.options.enablePunctuation) {
      const punctRegex = /[.,;:!?'"()[\]{}]/g;
      let punctMatch = punctRegex.exec(text);
      while (punctMatch !== null) {
        segments.push({
          word: punctMatch[0],
          startIndex: punctMatch.index,
          endIndex: punctMatch.index + 1,
        });
        punctMatch = punctRegex.exec(text);
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
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);

  // Bilingual subtitle (e.g. English + Chinese): prefer the Latin language so
  // word segmentation/selection still works on the English line. The Chinese
  // line is rendered separately as plain text.
  if (hasCjk && hasLatin) {
    if (/[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/i.test(text)) return "fr";
    if (/[äöüß]/i.test(text)) return "de";
    if (/[ñ¿¡]/i.test(text)) return "es";
    return "en";
  }

  // Pure CJK / other scripts
  if (hasCjk) {
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
