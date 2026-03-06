export interface ISubtitleCue {
  startTime: number;
  endTime: number;
  text: string;
}

export interface IWordSegment {
  word: string;
  startIndex: number;
  endIndex: number;
  isSelected?: boolean;
}

export interface IDictionaryEntry {
  word: string;
  pronunciation?: string;
  definitions: Array<{
    partOfSpeech: string;
    meaning: string;
    examples?: string[];
  }>;
  etymology?: string;
  morphology?: string;
  frequency?: number;
}

export interface ISegmentationOptions {
  language: string;
  enablePunctuation: boolean;
  minWordLength: number;
}

export interface ISubtitleTrackInfo {
  language: string;
  label: string;
  src: string;
  isActive: boolean;
}
