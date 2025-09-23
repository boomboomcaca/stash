export interface SubtitleCue {
  startTime: number;
  endTime: number;
  text: string;
}

export interface WordSegment {
  word: string;
  startIndex: number;
  endIndex: number;
  isSelected?: boolean;
}

export interface DictionaryEntry {
  word: string;
  pronunciation?: string;
  definitions: Array<{
    partOfSpeech: string;
    meaning: string;
    examples?: string[];
  }>;
  etymology?: string;
  frequency?: number;
}

export interface SegmentationOptions {
  language: string;
  enablePunctuation: boolean;
  minWordLength: number;
}

export interface SubtitleTrackInfo {
  language: string;
  label: string;
  src: string;
  isActive: boolean;
}
