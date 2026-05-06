import { useState, useEffect } from "react";

export type AutoPauseMode = "off" | "favorites" | "all";

interface ISubtitleSettings {
  fontSize: number;
  setFontSize: (size: number) => void;
  dragPosition: { y: number };
  setDragPosition: (pos: { y: number }) => void;
  autoPauseMode: AutoPauseMode;
  setAutoPauseMode: (mode: AutoPauseMode) => void;
  isPortrait: boolean;
}

// Helper: Load config from localStorage with type safety
export const loadConfig = <T>(
  key: string,
  defaultValue: T,
  parser?: (value: string) => T
): T => {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return defaultValue;
    return parser ? parser(saved) : (saved as unknown as T);
  } catch {
    return defaultValue;
  }
};

const computeIsPortrait = () =>
  typeof window !== "undefined" && window.innerHeight > window.innerWidth;

export function useSubtitleSettings(): ISubtitleSettings {
  const [fontSize, setFontSize] = useState(1.0);
  const [lastSavedFontSize, setLastSavedFontSize] = useState(1.0);
  const [dragPosition, setDragPosition] = useState({ y: 0 });
  const [lastSavedPosition, setLastSavedPosition] = useState({ y: 0 });
  const [autoPauseMode, setAutoPauseMode] = useState<AutoPauseMode>("off");
  const [isPortrait, setIsPortrait] = useState<boolean>(computeIsPortrait());

  // Load font size and auto-pause setting from localStorage
  useEffect(() => {
    const size = loadConfig("enhancedSubtitleFontSize", 1, parseFloat);
    if (size >= 0.5 && size <= 3.0) {
      setFontSize(size);
      setLastSavedFontSize(size);
    }
    const autoPause = loadConfig("enhancedSubtitleAutoPause", "", (v) => v);
    // Migrate legacy boolean values to tri-state mode
    if (autoPause === "true") {
      setAutoPauseMode("all");
    } else if (
      autoPause === "favorites" ||
      autoPause === "all" ||
      autoPause === "off"
    ) {
      setAutoPauseMode(autoPause as AutoPauseMode);
    } else {
      setAutoPauseMode("off");
    }
  }, []);

  // Orientation-aware load of saved position, with migration from legacy key
  useEffect(() => {
    const legacy = localStorage.getItem("enhancedSubtitlePosition");
    const portraitKey = "enhancedSubtitlePosition_portrait";
    const landscapeKey = "enhancedSubtitlePosition_landscape";

    // Migrate legacy position if present
    if (legacy && !localStorage.getItem(portraitKey)) {
      localStorage.setItem(portraitKey, legacy);
      localStorage.setItem(landscapeKey, legacy);
    }

    const key = isPortrait ? portraitKey : landscapeKey;
    const position = loadConfig(key, { y: 0 }, JSON.parse);
    setDragPosition(position);
    setLastSavedPosition(position);
  }, [isPortrait]);

  // Update portrait state on resize/orientation change
  useEffect(() => {
    const onResize = () => {
      const nextIsPortrait = computeIsPortrait();
      setIsPortrait((prev) => {
        if (prev !== nextIsPortrait) {
          return nextIsPortrait;
        }
        return prev;
      });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Save position to localStorage when it changes (per orientation)
  useEffect(() => {
    const saveTimer = setTimeout(() => {
      if (dragPosition.y !== lastSavedPosition.y) {
        const key = isPortrait
          ? "enhancedSubtitlePosition_portrait"
          : "enhancedSubtitlePosition_landscape";
        localStorage.setItem(key, JSON.stringify(dragPosition));
        setLastSavedPosition(dragPosition);
      }
    }, 500);

    return () => clearTimeout(saveTimer);
  }, [dragPosition, lastSavedPosition, isPortrait]);

  // Save font size to localStorage
  useEffect(() => {
    const saveTimer = setTimeout(() => {
      if (fontSize !== lastSavedFontSize) {
        localStorage.setItem("enhancedSubtitleFontSize", fontSize.toString());
        setLastSavedFontSize(fontSize);
      }
    }, 500);

    return () => clearTimeout(saveTimer);
  }, [fontSize, lastSavedFontSize]);

  // Save auto-pause setting to localStorage when it changes
  useEffect(() => {
    localStorage.setItem("enhancedSubtitleAutoPause", autoPauseMode);
  }, [autoPauseMode]);

  return {
    fontSize,
    setFontSize,
    dragPosition,
    setDragPosition,
    autoPauseMode,
    setAutoPauseMode,
    isPortrait,
  };
}
