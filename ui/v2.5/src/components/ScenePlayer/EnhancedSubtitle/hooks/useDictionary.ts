import { useState, useEffect, useCallback, useRef } from "react";
import { IDictionaryEntry, ISubtitleCue } from "../types";
import { lookupWord, lookupWordWithContext } from "../dictionary";
import {
  playWordPronunciation,
  preloadWordPronunciation,
} from "../pronunciation";
import { getFavorites, addFavorite, removeFavorite } from "../favorites";

interface IUseDictionaryProps {
  detectedLanguage: string;
  currentCue: ISubtitleCue | null;
  onPausePlayer?: () => void;
}

interface IUseDictionaryResult {
  selectedWord: string | null;
  setSelectedWord: (word: string | null) => void;
  dictionary: IDictionaryEntry | null;
  isLoading: boolean;
  showDictionary: boolean;
  setShowDictionary: (show: boolean) => void;
  showDictionaryRef: React.MutableRefObject<boolean>;
  isFavorite: boolean;
  favoriteWords: Set<string>;
  handleWordClick: (word: string) => Promise<void>;
  handlePronunciation: (word: string) => Promise<void>;
  toggleFavorite: () => Promise<void>;
  selectedActionIndex: number;
  setSelectedActionIndex: (index: number) => void;
}

export function useDictionary({
  detectedLanguage,
  currentCue,
  onPausePlayer,
}: IUseDictionaryProps): IUseDictionaryResult {
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [dictionary, setDictionary] = useState<IDictionaryEntry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showDictionary, setShowDictionary] = useState(false);
  const showDictionaryRef = useRef(false);

  // Sync showDictionary state to ref for callbacks
  useEffect(() => {
    showDictionaryRef.current = showDictionary;
  }, [showDictionary]);
  const [favoriteWords, setFavoriteWords] = useState<Set<string>>(new Set());
  const [isFavorite, setIsFavorite] = useState(false);
  const [selectedActionIndex, setSelectedActionIndex] = useState<number>(0);

  // Load favorites on mount
  useEffect(() => {
    const loadFavorites = async () => {
      const favorites = await getFavorites();
      const favSet = new Set(
        favorites.map((f) => `${f.word.toLowerCase()}:${f.language}`)
      );
      setFavoriteWords(favSet);
    };
    loadFavorites();
  }, []);

  // Clean up PronunciationService cache on unmount
  useEffect(() => {
    return () => {
      try {
        import("../pronunciation")
          .then(({ pronunciationService }) => {
            if (
              pronunciationService &&
              typeof pronunciationService.clearCache === "function"
            ) {
              pronunciationService.clearCache();
            }
          })
          .catch(() => {});
      } catch (error) {
        // ignore
      }
    };
  }, []);

  // Check if selected word is favorite
  useEffect(() => {
    if (selectedWord) {
      const key = `${selectedWord.toLowerCase()}:${detectedLanguage}`;
      setIsFavorite(favoriteWords.has(key));
    } else {
      setIsFavorite(false);
    }
  }, [selectedWord, detectedLanguage, favoriteWords]);

  // Pre-load pronunciation as soon as a word is selected and dictionary is shown
  useEffect(() => {
    if (showDictionary && selectedWord) {
      preloadWordPronunciation(selectedWord, detectedLanguage);
    }
  }, [showDictionary, selectedWord, detectedLanguage]);

  const handlePronunciation = useCallback(
    async (word: string) => {
      try {
        await playWordPronunciation(word, detectedLanguage);
      } catch (error) {
        console.error("Failed to play pronunciation:", error);
      }
    },
    [detectedLanguage]
  );

  const handleWordClick = useCallback(
    async (word: string) => {
      if (onPausePlayer) {
        onPausePlayer();
      }

      setSelectedWord(word);
      setIsLoading(true);
      setShowDictionary(true);

      try {
        const context = currentCue?.text || "";
        const entry = context
          ? await lookupWordWithContext(word, context, detectedLanguage)
          : await lookupWord(word, detectedLanguage);

        setDictionary(entry);
      } catch (error) {
        console.error("Dictionary lookup failed:", error);
        setDictionary(null);
      } finally {
        setIsLoading(false);
      }
    },
    [detectedLanguage, currentCue, onPausePlayer]
  );

  const toggleFavorite = useCallback(async () => {
    if (!selectedWord) return;

    const key = `${selectedWord.toLowerCase()}:${detectedLanguage}`;
    const newIsFavorite = !isFavorite;

    if (newIsFavorite) {
      const success = await addFavorite(selectedWord, detectedLanguage);
      if (success) {
        setFavoriteWords((prev) => new Set(prev).add(key));
        setIsFavorite(true);
      }
    } else {
      const success = await removeFavorite(selectedWord, detectedLanguage);
      if (success) {
        setFavoriteWords((prev) => {
          const newSet = new Set(prev);
          newSet.delete(key);
          return newSet;
        });
        setIsFavorite(false);
      }
    }
  }, [selectedWord, detectedLanguage, isFavorite]);

  return {
    selectedWord,
    setSelectedWord,
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
  };
}
