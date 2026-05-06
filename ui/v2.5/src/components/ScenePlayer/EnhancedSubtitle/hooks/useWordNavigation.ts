import { useState, useEffect, useCallback, useRef } from "react";
import { IWordSegment, ISubtitleCue } from "../types";
import { createSegmenter, detectLanguage } from "../segmentation";
import { AutoPauseMode } from "./useSubtitleSettings";

interface IUseWordNavigationProps {
  currentCue: ISubtitleCue | null;
  language: string;
  onWordSelect?: (word: string) => Promise<void>;
  // Ref to update when entering/exiting word navigation mode
  isInWordNavigationModeRef?: React.MutableRefObject<boolean>;
  // Whether manual auto-pause is enabled (for determining behavior on exit)
  autoPauseMode?: AutoPauseMode;
  // Callback to clear auto-pause timer
  clearAutoPauseTimeout?: () => void;
  // Callback to reset auto-pause state
  setIsAutoPaused?: (paused: boolean) => void;
  // Ref to reset when entering mode to ensure auto-pause triggers
  userResumedPlaybackRef?: React.MutableRefObject<boolean>;
  // Ref to reset when entering mode to allow auto-pause to re-trigger
  autoPauseTriggeredRef?: React.MutableRefObject<boolean>;
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
  onWordSelect,
  isInWordNavigationModeRef,
  autoPauseMode,
  clearAutoPauseTimeout,
  setIsAutoPaused,
  userResumedPlaybackRef,
  autoPauseTriggeredRef,
}: IUseWordNavigationProps): IUseWordNavigationResult {
  const [wordSegments, setWordSegments] = useState<IWordSegment[]>([]);
  const [detectedLanguage, setDetectedLanguage] = useState<string>(language);
  const [selectedWordIndex, setSelectedWordIndex] = useState<number>(-1);
  const [isInWordNavigationMode, setIsInWordNavigationMode] = useState(false);

  // Sync word navigation mode state to ref for useAutoPause
  useEffect(() => {
    if (isInWordNavigationModeRef) {
      isInWordNavigationModeRef.current = isInWordNavigationMode;
    }
  }, [isInWordNavigationMode, isInWordNavigationModeRef]);

  const prevCueRef = useRef<ISubtitleCue | null>(null);
  // Track whether auto-pause was manually enabled when entering word navigation mode
  const autoPauseWasEnabledOnEnterRef = useRef<boolean>(false);
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
        // Record whether manual auto-pause was enabled when entering word navigation mode
        autoPauseWasEnabledOnEnterRef.current =
          (autoPauseMode ?? "off") !== "off";
        setIsInWordNavigationMode(true);
        const initialIndex = selectLastWord ? wordSegments.length - 1 : 0;
        setSelectedWordIndex(initialIndex);
        prevCueRef.current = currentCue;

        // Synchronously update the ref for useAutoPause to see it IMMEDIATELY
        if (isInWordNavigationModeRef) {
          isInWordNavigationModeRef.current = true;
        }

        // Reset user manual resume flag in useAutoPause
        // This ensures that even if the user manually resumed playback earlier in this cue,
        // entering word navigation mode will re-trigger the auto-pause at the end of the cue.
        if (userResumedPlaybackRef) {
          userResumedPlaybackRef.current = false;
        }

        // Reset auto-pause triggered flag so auto-pause can re-trigger for this cue.
        // Without this, if AP already fired once for this cue and user resumed,
        // the autoPauseTriggeredRef would still be true, blocking both RAF and
        // setTimeout from pausing again.
        if (autoPauseTriggeredRef) {
          autoPauseTriggeredRef.current = false;
        }

        // Don't pause immediately - auto-pause will trigger when current subtitle ends
      }
    },
    [
      wordSegments,
      currentCue,
      autoPauseMode,
      isInWordNavigationModeRef,
      userResumedPlaybackRef,
      autoPauseTriggeredRef,
    ]
  );

  const exitWordNavigationMode = useCallback(() => {
    setIsInWordNavigationMode(false);
    setSelectedWordIndex(-1);

    // Synchronously update the ref BEFORE clearing timeout or resuming playback
    // This prevents useAutoPause from re-scheduling auto-pause when video resumes
    if (isInWordNavigationModeRef) {
      isInWordNavigationModeRef.current = false;
    }

    // If auto-pause was manually enabled before entering word navigation mode:
    // → Keep auto-pause behavior (don't resume, keep timer)
    // If auto-pause was triggered by entering word navigation mode:
    // → Clear auto-pause timer and resume playback
    if (autoPauseWasEnabledOnEnterRef.current) {
      // Manual auto-pause was on - keep auto-pause behavior
      // Don't resume playback, let auto-pause continue
    } else {
      // Auto-pause was triggered by word navigation mode
      // Clear the timer and reset auto-pause state
      // Note: Don't resume playback here - let the caller decide (handleHotkeys toggles play/pause)
      if (clearAutoPauseTimeout) {
        clearAutoPauseTimeout();
      }
      if (setIsAutoPaused) {
        setIsAutoPaused(false);
      }
    }
  }, [clearAutoPauseTimeout, isInWordNavigationModeRef, setIsAutoPaused]);

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

  // Exit word navigation mode when cue changes
  useEffect(() => {
    if (
      isInWordNavigationMode &&
      currentCue &&
      prevCueRef.current !== currentCue
    ) {
      setIsInWordNavigationMode(false);
      setSelectedWordIndex(-1);
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
