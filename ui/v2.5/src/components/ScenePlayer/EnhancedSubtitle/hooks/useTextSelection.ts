import { useState, useCallback, useRef, useEffect } from "react";

export interface ITextToken {
  id: string; // Unique key for react list rendering
  text: string; // Literal text content of this token
  startIndex: number; // Start index in the original cue text
  endIndex: number; // End index in the original cue text
  isWord: boolean; // Whether this is a clickable word segment
  wordIndex: number; // If it's a word, its index in the original wordSegments array. -1 otherwise.
}

interface IUseTextSelectionProps {
  textTokens: ITextToken[];
  /** The raw text of the current subtitle cue, used to extract text precisely */
  currentCueText: string;
}

interface IUseTextSelectionResult {
  /** Set of token indices currently selected by drag */
  dragSelectedIndices: Set<number>;
  /** Whether the user is currently dragging to select */
  isDragSelecting: boolean;
  /** Whether copy just succeeded (for visual feedback) */
  justCopied: boolean;
  /** Handler to attach on each token's onMouseDown */
  handleTokenMouseDown: (index: number, e: React.MouseEvent) => void;
  /** Handler to attach on each token's onMouseEnter (for drag extension) */
  handleTokenMouseEnter: (index: number) => void;
  /** Dismiss the selection */
  clearSelection: () => void;
}

/**
 * Hook: useTextSelection
 *
 * Enables mouse drag-to-select across all text tokens (words and punctuation/spaces).
 * When the user presses down on one token and drags across others,
 * all covered tokens are highlighted exactly where the mouse goes.
 * On mouse-up the selected text is copied to clipboard automatically.
 */
export function useTextSelection({
  textTokens,
  currentCueText,
}: IUseTextSelectionProps): IUseTextSelectionResult {
  const [dragSelectedIndices, setDragSelectedIndices] = useState<Set<number>>(
    new Set()
  );
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const [justCopied, setJustCopied] = useState(false);

  // Refs for tracking drag state without re-renders during move
  const dragStartIndexRef = useRef<number>(-1);
  const isDragSelectingRef = useRef(false);
  const hasDragMovedRef = useRef(false);
  const dragStartXRef = useRef<number>(0);
  const dragStartYRef = useRef<number>(0);
  // Ref to always have latest values in the mouseup closure
  const textTokensRef = useRef(textTokens);
  const currentCueTextRef = useRef(currentCueText);
  // Ref to detect touch screens
  const isTouchDeviceRef = useRef(false);

  useEffect(() => {
    const isTouch =
      typeof window !== "undefined" &&
      (window.matchMedia("(pointer: coarse)").matches ||
        "ontouchstart" in window);
    isTouchDeviceRef.current = isTouch;
  }, []);

  useEffect(() => {
    textTokensRef.current = textTokens;
  }, [textTokens]);

  useEffect(() => {
    currentCueTextRef.current = currentCueText;
  }, [currentCueText]);

  /** Extract text from original cue mapping exactly to the dragged tokens */
  const extractSelectedText = useCallback((indices: Set<number>): string => {
    if (indices.size === 0) return "";
    const tokens = textTokensRef.current;
    const text = currentCueTextRef.current;
    if (!text || tokens.length === 0) return "";

    const sorted = Array.from(indices).sort((a, b) => a - b);
    const firstIdx = sorted[0];
    const lastIdx = sorted[sorted.length - 1];

    const firstToken = tokens[firstIdx];
    const lastToken = tokens[lastIdx];
    if (!firstToken || !lastToken) return "";

    // Just slice exactly what covers the selected tokens
    // If the user wants trailing punctuation, they drag over it.
    return text.slice(firstToken.startIndex, lastToken.endIndex);
  }, []);

  /** Copy text to clipboard */
  const copyToClipboard = useCallback((text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {
      // Fallback for environments without clipboard API
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      try {
        textarea.select();
        document.execCommand("copy");
      } finally {
        document.body.removeChild(textarea);
      }
    });
  }, []);

  const handleTokenMouseDown = useCallback(
    (index: number, e: React.MouseEvent) => {
      // Touch devices use standard dictionary taps; custom drag-select is mouse only
      if (isTouchDeviceRef.current) return;

      // Only respond to left mouse button
      if (e.button !== 0) return;

      dragStartIndexRef.current = index;
      isDragSelectingRef.current = true;
      hasDragMovedRef.current = false;
      dragStartXRef.current = e.clientX;
      dragStartYRef.current = e.clientY;

      // Start with the anchor token selected
      setDragSelectedIndices(new Set([index]));
      setIsDragSelecting(true);
      setJustCopied(false);
    },
    []
  );

  const handleTokenMouseEnter = useCallback((index: number) => {
    if (!isDragSelectingRef.current) return;
    if (dragStartIndexRef.current < 0) return;

    hasDragMovedRef.current = true;

    // Compute the contiguous range between anchor and current
    const start = Math.min(dragStartIndexRef.current, index);
    const end = Math.max(dragStartIndexRef.current, index);
    const indices = new Set<number>();
    for (let i = start; i <= end; i++) {
      indices.add(i);
    }
    setDragSelectedIndices(indices);
  }, []);

  // Global mouseup listener to finalize or cancel the drag
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (!isDragSelectingRef.current) return;

      isDragSelectingRef.current = false;
      setIsDragSelecting(false);

      if (!hasDragMovedRef.current) {
        const deltaX = Math.abs(e.clientX - dragStartXRef.current);
        const deltaY = Math.abs(e.clientY - dragStartYRef.current);
        // 如果在同一个单词内偏移超过 3 像素，也认为是拖拽
        if (deltaX > 3 || deltaY > 3) {
          hasDragMovedRef.current = true;
        }
      }

      if (hasDragMovedRef.current) {
        // Use functional setState to read the latest drag-selected indices
        setDragSelectedIndices((currentIndices) => {
          if (currentIndices.size > 0) {
            const text = extractSelectedText(currentIndices);
            if (text) {
              copyToClipboard(text);
              setJustCopied(true);
              // Auto-clear the selection after a brief highlight
              setTimeout(() => {
                setDragSelectedIndices(new Set());
                setJustCopied(false);
              }, 800);
            }
          }
          return currentIndices; // Keep indices visible during the feedback period
        });
      } else {
        // Single click (no drag movement) - clear and let onClick handle it
        // Note: we let onClick event on words trigger the dictionary.
        setDragSelectedIndices(new Set());
      }

      dragStartIndexRef.current = -1;
      hasDragMovedRef.current = false;
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [extractSelectedText, copyToClipboard]);

  // Clear selection when tokens change (new subtitle cue)
  // biome-ignore lint/correctness/useExhaustiveDependencies: textTokens is an intentional trigger: reset the selection whenever a new cue's tokens arrive
  useEffect(() => {
    setDragSelectedIndices(new Set());
    setIsDragSelecting(false);
    setJustCopied(false);
    isDragSelectingRef.current = false;
    dragStartIndexRef.current = -1;
    hasDragMovedRef.current = false;
  }, [textTokens]);

  const clearSelection = useCallback(() => {
    setDragSelectedIndices(new Set());
    setIsDragSelecting(false);
    setJustCopied(false);
    isDragSelectingRef.current = false;
    dragStartIndexRef.current = -1;
    hasDragMovedRef.current = false;
  }, []);

  return {
    dragSelectedIndices,
    isDragSelecting,
    justCopied,
    handleTokenMouseDown,
    handleTokenMouseEnter,
    clearSelection,
  };
}
