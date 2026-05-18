import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { ISubtitleCue } from "./types";
import {
  useSubtitleSettings,
  useSubtitleDrag,
  useSubtitleParser,
  useAutoPause,
  useWordNavigation,
  useDictionary,
  useTextSelection,
  ITextToken,
} from "./hooks";
import { DictionaryModal } from "./components/DictionaryModal";
import "./styles.scss";

interface IEnhancedSubtitleOverlayProps {
  currentTime: number;
  subtitleTrack: string | null;
  isVisible: boolean;
  language?: string;
  isFullscreen?: boolean;
  onToggleVisibility: () => void;
  onPausePlayer?: () => void;
  getPlayerPaused?: () => boolean;
  resetFontSizeTrigger?: number;
  onSubtitlesLoaded?: (cues: ISubtitleCue[]) => void;
  onCurrentCueChange?: (index: number) => void;
  onAPDoubleClick?: () => void;
  onPlay?: () => void;
  onSeekToCue?: (cueIndex: number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onGetPlayer?: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigationRef?: (ref: any) => void;
}

export const EnhancedSubtitleOverlay: React.FC<
  IEnhancedSubtitleOverlayProps
> = ({
  currentTime,
  subtitleTrack,
  isVisible,
  language = "en",
  isFullscreen = false,
  onPausePlayer,
  getPlayerPaused,
  resetFontSizeTrigger,
  onSubtitlesLoaded,
  onCurrentCueChange,
  onAPDoubleClick,
  onPlay,
  onGetPlayer,
  onNavigationRef,
}) => {
  const [fullscreenContainer, setFullscreenContainer] =
    useState<HTMLElement | null>(null);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const isInWordNavigationModeRef = useRef<boolean>(false);

  // Settings hook
  const {
    fontSize,
    setFontSize,
    dragPosition,
    setDragPosition,
    autoPauseMode,
    setAutoPauseMode,
    isPortrait,
  } = useSubtitleSettings();

  // Subtitle parser hook
  const { parsedSubtitles } = useSubtitleParser({
    subtitleTrack,
    onSubtitlesLoaded,
  });

  // Pre-initialize values for useAutoPause (synced from useDictionary/useWordNavigation below)
  const [favoriteWordsForAutoPause, setFavoriteWordsForAutoPause] = useState<
    Set<string>
  >(new Set());
  const [detectedLanguageForAutoPause, setDetectedLanguageForAutoPause] =
    useState<string>(language);

  // Auto-pause hook
  const {
    currentCue,
    isAutoPaused,
    setIsAutoPaused,
    isPlayerPaused,
    userResumedPlaybackRef,
    autoPauseTriggeredRef,
    clearAutoPauseTimeout,
  } = useAutoPause({
    currentTime,
    parsedSubtitles,
    autoPauseMode,
    favoriteWords: favoriteWordsForAutoPause,
    detectedLanguage: detectedLanguageForAutoPause,
    onPausePlayer,
    getPlayerPaused,
    onCurrentCueChange,
    onGetPlayer,
    isInWordNavigationModeRef,
  });

  // Word navigation hook
  const {
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
  } = useWordNavigation({
    currentCue,
    language,
    isInWordNavigationModeRef,
    autoPauseMode,
    clearAutoPauseTimeout,
    setIsAutoPaused,
    userResumedPlaybackRef,
    autoPauseTriggeredRef,
  });

  // Dictionary hook
  const {
    selectedWord,
    dictionary,
    isLoading,
    showDictionary,
    setShowDictionary,
    showDictionaryRef,
    isFavorite,
    favoriteWords,
    handleWordClick,
    handlePronunciation,
    toggleFavorite,
    selectedActionIndex,
    setSelectedActionIndex,
    aiProvider,
    setAiProvider,
    targetLanguage,
    setTargetLanguage,
  } = useDictionary({
    detectedLanguage,
    currentCue,
    onPausePlayer,
  });

  // Generate flat list of tokens (words and punctuation) for unified selection
  const textTokens = useMemo(() => {
    if (!currentCue || wordSegments.length === 0) return [];
    const tokens: Array<ITextToken> = [];
    let lastIndex = 0;

    const addNonWordTokens = (
      text: string,
      startIdx: number,
      baseId: string
    ) => {
      let currentStart = startIdx;
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        if (lineText.length > 0) {
          tokens.push({
            id: `${baseId}-line-${idx}`,
            text: lineText,
            startIndex: currentStart,
            endIndex: currentStart + lineText.length,
            isWord: false,
            wordIndex: -1,
          });
        }
        currentStart += lineText.length;

        if (idx < lines.length - 1) {
          tokens.push({
            id: `${baseId}-br-${idx}`,
            text: "\n",
            startIndex: currentStart,
            endIndex: currentStart + 1,
            isWord: false,
            wordIndex: -1,
          });
          currentStart += 1;
        }
      });
    };

    wordSegments.forEach((segment, index) => {
      if (segment.startIndex > lastIndex) {
        addNonWordTokens(
          currentCue.text.slice(lastIndex, segment.startIndex),
          lastIndex,
          `between-${index}`
        );
      }
      tokens.push({
        id: `word-${index}`,
        text: segment.word,
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        isWord: true,
        wordIndex: index,
      });
      lastIndex = segment.endIndex;
    });

    if (lastIndex < currentCue.text.length) {
      addNonWordTokens(
        currentCue.text.slice(lastIndex),
        lastIndex,
        `remaining`
      );
    }

    return tokens;
  }, [currentCue, wordSegments]);

  // Text selection hook (mouse drag to select and copy)
  const {
    dragSelectedIndices,
    isDragSelecting,
    justCopied,
    handleTokenMouseDown,
    handleTokenMouseEnter,
    clearSelection,
  } = useTextSelection({
    textTokens,
    currentCueText: currentCue?.text ?? "",
  });

  // Sync favoriteWords and detectedLanguage to useAutoPause
  useEffect(() => {
    setFavoriteWordsForAutoPause(favoriteWords);
  }, [favoriteWords]);
  useEffect(() => {
    setDetectedLanguageForAutoPause(detectedLanguage);
  }, [detectedLanguage]);

  // Bind handleWordClick to word navigation for keyboard selection
  useEffect(() => {
    setOnWordSelect(handleWordClick);
  }, [setOnWordSelect, handleWordClick]);

  // Ref to avoid handleWordClick as a dependency of the auto-show effect
  const handleWordClickRef = useRef(handleWordClick);
  useEffect(() => {
    handleWordClickRef.current = handleWordClick;
  }, [handleWordClick]);

  // Ref to track selectedWord without adding it as a dependency
  const selectedWordRef = useRef(selectedWord);
  useEffect(() => {
    selectedWordRef.current = selectedWord;
  }, [selectedWord]);

  // Auto-show/update dictionary when navigating
  useEffect(() => {
    if (
      isInWordNavigationMode &&
      selectedWordIndex >= 0 &&
      selectedWordIndex < wordSegments.length &&
      wordSegments[selectedWordIndex]
    ) {
      const { word } = wordSegments[selectedWordIndex];
      const wordKey = `${word.toLowerCase()}:${detectedLanguage}`;
      // Auto-show if favorited OR update if dictionary is already open
      if (favoriteWords.has(wordKey) || showDictionaryRef.current) {
        // Avoid redundant calls if the word is already selected in dictionary
        if (selectedWordRef.current !== word) {
          handleWordClickRef.current(word);
        }
      }
    }
  }, [
    isInWordNavigationMode,
    selectedWordIndex,
    wordSegments,
    detectedLanguage,
    favoriteWords,
    showDictionaryRef,
  ]);

  // Drag hook
  const {
    isDragging,
    dragMode,
    handleAPMouseDown,
    handleAPTouchStart,
    handleAPClick,
  } = useSubtitleDrag({
    dragPosition,
    setDragPosition,
    fontSize,
    setFontSize,
    autoPauseMode,
    setAutoPauseMode,
    setIsAutoPaused,
    onAPDoubleClick,
  });

  // Reset font size when trigger changes
  useEffect(() => {
    if (resetFontSizeTrigger !== undefined && resetFontSizeTrigger > 0) {
      setFontSize(1.0);
    }
  }, [resetFontSizeTrigger, setFontSize]);

  // Find fullscreen container
  useEffect(() => {
    if (!isFullscreen) {
      setFullscreenContainer(null);
      return;
    }

    const findFullscreenContainer = () => {
      const pseudoFullscreen = document.querySelector(
        ".vjs-pseudo-fullscreen"
      ) as HTMLElement;
      if (pseudoFullscreen) {
        setFullscreenContainer(pseudoFullscreen);
        return;
      }

      const playerContainer = document.querySelector(
        ".video-js.vjs-pseudo-fullscreen"
      ) as HTMLElement;
      if (playerContainer) {
        setFullscreenContainer(playerContainer);
        return;
      }

      setFullscreenContainer(document.body);
    };

    findFullscreenContainer();
    const timer = setTimeout(findFullscreenContainer, 100);

    return () => {
      clearTimeout(timer);
      setFullscreenContainer(null);
    };
  }, [isFullscreen]);

  // Hide dictionary when player starts playing
  useEffect(() => {
    if (!onGetPlayer) return;

    const player = onGetPlayer();
    if (!player) return;

    const handlePlay = () => {
      setShowDictionary(false);
    };

    if (typeof player.on === "function") {
      player.on("play", handlePlay);
    }

    return () => {
      if (typeof player.off === "function") {
        player.off("play", handlePlay);
      }
    };
  }, [onGetPlayer, setShowDictionary]);

  // Expose navigation functions to parent
  useEffect(() => {
    if (onNavigationRef) {
      onNavigationRef({
        enterWordNavigationMode,
        exitWordNavigationMode,
        navigateToNextWord,
        navigateToPreviousWord,
        handleWordSelection,
        isInWordNavigationMode,
        isAutoPaused,
        resumePlayback: () => {
          if (onPlay && isAutoPaused) {
            onPlay();
            setIsAutoPaused(false);
            userResumedPlaybackRef.current = true;
          }
        },
        markUserResumedPlayback: () => {
          userResumedPlaybackRef.current = true;
        },
        clearScheduledAutoPause: clearAutoPauseTimeout,
        parsedSubtitles,
        getCurrentCueIndex: () => {
          if (currentCue && parsedSubtitles) {
            return parsedSubtitles.cues.findIndex(
              (c) =>
                c.startTime === currentCue.startTime &&
                c.endTime === currentCue.endTime &&
                c.text === currentCue.text
            );
          }
          return -1;
        },
        onGetPlayer,
        // 词典相关 - 使用 ref 确保回调获取最新值
        isDictionaryVisible: () => showDictionaryRef.current,
        pronounceCurrentWord: async () => {
          if (selectedWord) {
            await handlePronunciation(selectedWord);
          }
        },
        closeDictionary: () => setShowDictionary(false),
      });
    }
  }, [
    onNavigationRef,
    enterWordNavigationMode,
    exitWordNavigationMode,
    navigateToNextWord,
    navigateToPreviousWord,
    handleWordSelection,
    isInWordNavigationMode,
    isAutoPaused,
    onPlay,
    currentCue,
    parsedSubtitles,
    onGetPlayer,
    setIsAutoPaused,
    userResumedPlaybackRef,
    clearAutoPauseTimeout,
    showDictionaryRef,
    setShowDictionary,
    selectedWord,
    handlePronunciation,
  ]);

  // Render segmented text with clickable words
  const renderSegmentedText = useMemo(() => {
    if (!currentCue || textTokens.length === 0) {
      return (
        currentCue?.text.split("\n").map((line, idx, arr) => (
          <React.Fragment key={idx}>
            {line}
            {idx < arr.length - 1 && <br />}
          </React.Fragment>
        )) || ""
      );
    }

    const elements = textTokens.map((token, tokenIndex) => {
      const isDragSelected = dragSelectedIndices.has(tokenIndex);

      if (token.isWord) {
        const wordSegment = wordSegments[token.wordIndex];
        const wordKey = `${token.text.toLowerCase()}:${detectedLanguage}`;
        const isFavorited = favoriteWords.has(wordKey);
        const isSelectedInNav =
          isInWordNavigationMode && token.wordIndex === selectedWordIndex;

        return (
          <span
            key={token.id}
            className={`subtitle-word ${
              wordSegment.isSelected ? "selected" : ""
            } ${isSelectedInNav ? "navigation-selected" : ""} ${
              isFavorited ? "favorited" : ""
            } ${isDragSelected ? "drag-selected" : ""} ${
              isDragSelected && justCopied ? "just-copied" : ""
            }`}
            onClick={() => {
              // Only trigger dictionary lookup if not in drag-select mode
              if (!isDragSelecting && dragSelectedIndices.size === 0) {
                handleWordClick(token.text);
                setSelectedWordIndex(token.wordIndex);
              } else {
                clearSelection();
              }
            }}
            onMouseDown={(e) => handleTokenMouseDown(tokenIndex, e)}
            onMouseEnter={() => handleTokenMouseEnter(tokenIndex)}
            onTouchEnd={(e) => {
              if (isDragging) return;
              e.preventDefault();
              e.stopPropagation();
              handleWordClick(token.text);
              setSelectedWordIndex(token.wordIndex);
            }}
          >
            {token.text}
          </span>
        );
      } else {
        if (token.text === "\n") {
          return <br key={token.id} />;
        }

        const highlightClass = `subtitle-between-text${
          isDragSelected ? " drag-selected" : ""
        }${isDragSelected && justCopied ? " just-copied" : ""}`;

        return (
          <span
            key={token.id}
            className={highlightClass}
            onMouseDown={(e) => handleTokenMouseDown(tokenIndex, e)}
            onMouseEnter={() => handleTokenMouseEnter(tokenIndex)}
          >
            {token.text}
          </span>
        );
      }
    });

    return elements;
  }, [
    currentCue,
    textTokens,
    wordSegments,
    handleWordClick,
    detectedLanguage,
    favoriteWords,
    isInWordNavigationMode,
    selectedWordIndex,
    isDragging,
    isDragSelecting,
    justCopied,
    dragSelectedIndices,
    handleTokenMouseDown,
    handleTokenMouseEnter,
    clearSelection,
    setSelectedWordIndex,
  ]);

  if (!isVisible) {
    return null;
  }

  const subtitleContent = (
    <div
      ref={subtitleRef}
      className={`enhanced-subtitle-overlay ${
        isFullscreen ? "fullscreen-mode" : ""
      } ${isDragging ? "dragging" : ""} ${
        isPortrait ? "portrait-mode" : "landscape-mode"
      }`}
      style={{
        transform: `translateX(-50%) translateY(${dragPosition.y}px)`,
      }}
    >
      <div
        className={`subtitle-text ${!currentCue ? "no-content" : ""}`}
        style={{
          fontSize: `${fontSize * (isFullscreen ? 2.6 : 1.9)}rem`,
        }}
      >
        <div
          className={`drag-indicator ${
            autoPauseMode === "all"
              ? "auto-pause-active"
              : autoPauseMode === "favorites"
              ? "auto-pause-favorites"
              : ""
          }`}
          onMouseDown={handleAPMouseDown}
          onTouchStart={handleAPTouchStart}
          onClick={handleAPClick}
        >
          <svg
            className="pause-icon"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            {isPlayerPaused || isAutoPaused ? (
              <>
                <rect
                  x="6"
                  y="4"
                  width="4"
                  height="16"
                  rx="1"
                  fill="currentColor"
                />
                <rect
                  x="14"
                  y="4"
                  width="4"
                  height="16"
                  rx="1"
                  fill="currentColor"
                />
              </>
            ) : (
              <polygon points="8,4 20,12 8,20" fill="currentColor" />
            )}
          </svg>
        </div>

        {currentCue && renderSegmentedText}
      </div>

      {isDragging && dragMode === "size" && (
        <div className="font-size-indicator">{Math.round(fontSize * 100)}%</div>
      )}

      <DictionaryModal
        showDictionary={showDictionary}
        setShowDictionary={setShowDictionary}
        isFullscreen={isFullscreen}
        fullscreenContainer={fullscreenContainer}
        selectedWord={selectedWord}
        dictionary={dictionary}
        isLoading={isLoading}
        isFavorite={isFavorite}
        selectedActionIndex={selectedActionIndex}
        setSelectedActionIndex={setSelectedActionIndex}
        handlePronunciation={handlePronunciation}
        toggleFavorite={toggleFavorite}
        aiProvider={aiProvider}
        setAiProvider={setAiProvider}
        targetLanguage={targetLanguage}
        setTargetLanguage={setTargetLanguage}
      />
    </div>
  );

  if (isFullscreen && fullscreenContainer) {
    return createPortal(subtitleContent, fullscreenContainer);
  }

  return subtitleContent;
};
