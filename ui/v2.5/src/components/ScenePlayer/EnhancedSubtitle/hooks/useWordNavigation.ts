import { useState, useEffect, useCallback, useRef } from "react";
import { IWordSegment, ISubtitleCue } from "../types";
import { createSegmenter, detectLanguage } from "../segmentation";

interface IUseWordNavigationProps {
  currentCue: ISubtitleCue | null;
  language: string;
  onPausePlayer?: () => void;
  onPlay?: () => void;
  isAutoPaused: boolean;
  onWordSelect?: (word: string) => Promise<void>;
}

interface IUseWordNavigationResult {
  wordSegments: IWordSegment[];
  detectedLanguage: string;
  selectedWordIndex: number;
  setSelectedWordIndex: (index: number) => void;
  isInWordNavigationMode: boolean;
  enterWordNavigationMode: (selectLastWord?: boolean) => void;
  exitWordNavigationMode: () => void;
  navigateToNextWord: () => void;
  navigateToPreviousWord: () => void;
  handleWordSelection: () => Promise<void>;
  setOnWordSelect: (callback: ((word: string) => Promise<void>) | null) => void;
}

export function useWordNavigation({
  currentCue,
  language,
  onPausePlayer,
  onPlay,
  isAutoPaused,
  onWordSelect,
}: IUseWordNavigationProps): IUseWordNavigationResult {
  const [wordSegments, setWordSegments] = useState<IWordSegment[]>([]);
  const [detectedLanguage, setDetectedLanguage] = useState<string>(language);
  const [selectedWordIndex, setSelectedWordIndex] = useState<number>(-1);
  const [isInWordNavigationMode, setIsInWordNavigationMode] = useState(false);

  const prevCueRef = useRef<ISubtitleCue | null>(null);
  const segmenterRef = useRef(
    createSegmenter({
      language: detectedLanguage,
      enablePunctuation: false,
      minWordLength: 1,
    })
  );

  // Store handleWordClick callback for word selection
  const handleWordClickRef = useRef<((word: string) => Promise<void>) | null>(
    null
  );

  // Update ref when onWordSelect changes
  useEffect(() => {
    handleWordClickRef.current = onWordSelect || null;
  }, [onWordSelect]);

  // Allow external setting of word select callback
  const setOnWordSelect = useCallback(
    (callback: ((word: string) => Promise<void>) | null) => {
      handleWordClickRef.current = callback;
    },
    []
  );

  // Segment current cue text
  useEffect(() => {
    if (!currentCue) {
      setWordSegments([]);
      return;
    }

    const detected = detectLanguage(currentCue.text);
    if (detected !== detectedLanguage) {
      setDetectedLanguage(detected);
      segmenterRef.current = createSegmenter({
        language: detected,
        enablePunctuation: false,
        minWordLength: 1,
      });
    }

    const segments = segmenterRef.current.segmentText(currentCue.text);
    setWordSegments(segments);
  }, [currentCue, detectedLanguage]);

  const enterWordNavigationMode = useCallback(
    (selectLastWord: boolean = false) => {
      if (wordSegments.length > 0) {
        setIsInWordNavigationMode(true);
        const initialIndex = selectLastWord ? wordSegments.length - 1 : 0;
        setSelectedWordIndex(initialIndex);
        prevCueRef.current = currentCue;
        if (onPausePlayer) {
          onPausePlayer();
        }
      }
    },
    [wordSegments, onPausePlayer, currentCue]
  );

  const exitWordNavigationMode = useCallback(() => {
    setIsInWordNavigationMode(false);
    setSelectedWordIndex(-1);
    if (onPlay && !isAutoPaused) {
      onPlay();
    }
  }, [onPlay, isAutoPaused]);

  const navigateToNextWord = useCallback(() => {
    if (wordSegments.length === 0) return;
    if (selectedWordIndex === -1) {
      setSelectedWordIndex(0);
      return;
    }
    if (selectedWordIndex < wordSegments.length - 1) {
      setSelectedWordIndex(selectedWordIndex + 1);
    } else {
      setSelectedWordIndex(0);
    }
  }, [selectedWordIndex, wordSegments.length]);

  const navigateToPreviousWord = useCallback(() => {
    if (wordSegments.length === 0) return;
    if (selectedWordIndex === -1) {
      return;
    }
    if (selectedWordIndex > 0) {
      setSelectedWordIndex(selectedWordIndex - 1);
    } else {
      setSelectedWordIndex(wordSegments.length - 1);
    }
  }, [selectedWordIndex, wordSegments.length]);

  const handleWordSelection = useCallback(async () => {
    if (
      selectedWordIndex >= 0 &&
      selectedWordIndex < wordSegments.length &&
      wordSegments[selectedWordIndex] &&
      handleWordClickRef.current
    ) {
      const selectedWordText = wordSegments[selectedWordIndex].word;
      await handleWordClickRef.current(selectedWordText);
    }
  }, [selectedWordIndex, wordSegments]);

  // Update word navigation when cue changes
  useEffect(() => {
    if (
      isInWordNavigationMode &&
      currentCue &&
      prevCueRef.current !== currentCue
    ) {
      setSelectedWordIndex(0);
    }
    prevCueRef.current = currentCue;
  }, [currentCue, isInWordNavigationMode]);

  return {
    wordSegments,
    detectedLanguage,
    selectedWordIndex,
    setSelectedWordIndex,
    isInWordNavigationMode,
    enterWordNavigationMode,
    exitWordNavigationMode,
    navigateToNextWord,
    navigateToPreviousWord,
    handleWordSelection,
    setOnWordSelect,
  };
}
