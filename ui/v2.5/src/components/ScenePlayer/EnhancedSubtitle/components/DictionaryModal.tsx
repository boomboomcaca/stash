import React, { useEffect, useRef, useCallback } from "react";
import { Modal } from "react-bootstrap";
import { IDictionaryEntry } from "../types";

interface IDictionaryModalProps {
  showDictionary: boolean;
  setShowDictionary: (show: boolean) => void;
  isFullscreen: boolean;
  fullscreenContainer: HTMLElement | null;
  selectedWord: string | null;
  dictionary: IDictionaryEntry | null;
  isLoading: boolean;
  isFavorite: boolean;
  selectedActionIndex: number;
  setSelectedActionIndex: (index: number) => void;
  handlePronunciation: (word: string) => Promise<void>;
  toggleFavorite: () => Promise<void>;
}

export const DictionaryModal: React.FC<IDictionaryModalProps> = ({
  showDictionary,
  setShowDictionary,
  isFullscreen,
  fullscreenContainer,
  selectedWord,
  dictionary,
  isLoading,
  isFavorite,
  selectedActionIndex,
  setSelectedActionIndex,
  handlePronunciation,
  toggleFavorite,
}) => {
  const dictionaryTouchStartYRef = useRef<number | null>(null);
  const dictionaryTouchTriggeredRef = useRef<boolean>(false);
  const selectedActionIndexRef = useRef(selectedActionIndex);
  selectedActionIndexRef.current = selectedActionIndex;

  const selectedWordRef = useRef(selectedWord);
  selectedWordRef.current = selectedWord;

  // 使用 ref 存储 handlePronunciation 和 toggleFavorite，避免 useEffect 频繁重新注册事件监听器
  const handlePronunciationRef = useRef(handlePronunciation);
  handlePronunciationRef.current = handlePronunciation;

  const toggleFavoriteRef = useRef(toggleFavorite);
  toggleFavoriteRef.current = toggleFavorite;

  const handleDictionaryTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!showDictionary) return;
      if (e.touches.length !== 1) return;
      dictionaryTouchStartYRef.current = e.touches[0].clientY;
      dictionaryTouchTriggeredRef.current = false;
    },
    [showDictionary]
  );

  const handleDictionaryTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!showDictionary) return;
      if (e.touches.length !== 1) return;
      if (dictionaryTouchStartYRef.current == null) return;
      const currentY = e.touches[0].clientY;
      const deltaY = currentY - dictionaryTouchStartYRef.current;
      const THRESHOLD = 5;
      // 向上滑动（deltaY < -THRESHOLD）或向下滑动（deltaY > THRESHOLD）都关闭词典
      if (
        Math.abs(deltaY) > THRESHOLD &&
        !dictionaryTouchTriggeredRef.current
      ) {
        dictionaryTouchTriggeredRef.current = true;
        setShowDictionary(false);
        e.stopPropagation();
      }
    },
    [showDictionary, setShowDictionary]
  );

  const handleDictionaryTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      // 如果没有触发滑动关闭，则单击朗读单词
      if (
        !dictionaryTouchTriggeredRef.current &&
        dictionaryTouchStartYRef.current !== null
      ) {
        // 检查点击目标是否是按钮，如果是则不触发朗读
        const target = e.target as HTMLElement;
        const isButton =
          target.closest("button") || target.closest(".dict-action-btn");
        if (!isButton) {
          const word = selectedWordRef.current;
          if (word) {
            handlePronunciation(word);
          }
          e.preventDefault();
          e.stopPropagation();
        }
      }
      dictionaryTouchStartYRef.current = null;
      dictionaryTouchTriggeredRef.current = false;
    },
    [handlePronunciation]
  );

  // Keyboard event listener for dictionary modal
  useEffect(() => {
    if (!showDictionary) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const { key } = e;
      const keyCode = e.keyCode || e.which;
      const keyLower = key.toLowerCase();

      if (
        key === "ArrowLeft" ||
        keyCode === 37 ||
        keyLower === "a" ||
        keyCode === 65
      ) {
        e.preventDefault();
        e.stopPropagation();
        setSelectedActionIndex(
          selectedActionIndexRef.current > 0
            ? selectedActionIndexRef.current - 1
            : 2
        );
        return;
      }

      if (
        key === "ArrowRight" ||
        keyCode === 39 ||
        keyLower === "d" ||
        keyCode === 68
      ) {
        e.preventDefault();
        e.stopPropagation();
        setSelectedActionIndex(
          selectedActionIndexRef.current < 2
            ? selectedActionIndexRef.current + 1
            : 0
        );
        return;
      }

      if (
        key === "Enter" ||
        key === "Ok" ||
        keyCode === 13 ||
        key === " " ||
        keyCode === 32
      ) {
        e.preventDefault();
        e.stopPropagation();
        const currentIndex = selectedActionIndexRef.current;
        if (currentIndex === 0) {
          const word = selectedWordRef.current;
          if (word) {
            handlePronunciationRef.current(word);
          }
        } else if (currentIndex === 1) {
          toggleFavoriteRef.current();
        } else if (currentIndex === 2) {
          setShowDictionary(false);
        }
        return;
      }

      if (
        key === "ArrowUp" ||
        keyCode === 38 ||
        keyLower === "w" ||
        keyCode === 87
      ) {
        e.preventDefault();
        e.stopPropagation();
        setShowDictionary(false);
        return;
      }

      if (key === "Escape" || keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        setShowDictionary(false);
        return;
      }
    };

    setSelectedActionIndex(0);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [showDictionary, setShowDictionary, setSelectedActionIndex]);

  return (
    <Modal
      show={showDictionary}
      onHide={() => setShowDictionary(false)}
      className={`dictionary-modal ${
        isFullscreen ? "fullscreen-dictionary" : ""
      }`}
      centered
      container={
        isFullscreen && fullscreenContainer ? fullscreenContainer : undefined
      }
    >
      <Modal.Header
        closeButton={false}
        onTouchStart={handleDictionaryTouchStart}
        onTouchMove={handleDictionaryTouchMove}
        onTouchEnd={handleDictionaryTouchEnd}
      >
        <Modal.Title
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            width: "100%",
          }}
        >
          <span className="word-text">{selectedWord}</span>
          <div
            className="dictionary-actions"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <button
              className={`dict-action-btn ${
                selectedActionIndex === 0 ? "selected" : ""
              }`}
              onClick={() => selectedWord && handlePronunciation(selectedWord)}
              title="播放发音"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            </button>
            <button
              className={`dict-action-btn ${
                selectedActionIndex === 1 ? "selected" : ""
              } ${isFavorite ? "favorited" : ""}`}
              onClick={toggleFavorite}
              title={isFavorite ? "取消收藏" : "添加到收藏"}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill={isFavorite ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
            <button
              className={`dict-action-btn ${
                selectedActionIndex === 2 ? "selected" : ""
              }`}
              onClick={() => setShowDictionary(false)}
              title="关闭"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </Modal.Title>
      </Modal.Header>
      <Modal.Body
        onTouchStart={handleDictionaryTouchStart}
        onTouchMove={handleDictionaryTouchMove}
        onTouchEnd={handleDictionaryTouchEnd}
      >
        {isLoading ? (
          <div className="text-center py-3">
            <div className="spinner-border spinner-border-sm" role="status">
              <span className="sr-only">Loading...</span>
            </div>
          </div>
        ) : dictionary ? (
          <div className="dictionary-content">
            {dictionary.definitions.map((def, index) => (
              <div key={index} className="definition">
                <div className="pos-phonetic-line">
                  <span className="pos-tag">{def.partOfSpeech}</span>
                </div>
                {index === 0 && dictionary.morphology && (
                  <div className="meaning morphology-inline">
                    {dictionary.morphology
                      .split("\n")
                      .map((line, lineIndex) => (
                        <p key={lineIndex} className="meaning-line">
                          {line}
                        </p>
                      ))}
                  </div>
                )}
                <div className="meaning">
                  {def.meaning.split("\n").map((line, lineIndex) => (
                    <p key={lineIndex} className="meaning-line">
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="text-center py-3"
            style={{
              minHeight: "100px",
              paddingTop: "20px",
              paddingBottom: "20px",
            }}
          >
            <p className="mb-0 text-muted">未找到释义</p>
          </div>
        )}
      </Modal.Body>
    </Modal>
  );
};
