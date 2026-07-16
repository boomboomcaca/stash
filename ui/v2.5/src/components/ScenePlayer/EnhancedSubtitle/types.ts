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
  morphology?: string;
  frequency?: number;
  aiSource?: string;
}

export interface ISegmentationOptions {
  language: string;
  enablePunctuation: boolean;
  minWordLength: number;
}
