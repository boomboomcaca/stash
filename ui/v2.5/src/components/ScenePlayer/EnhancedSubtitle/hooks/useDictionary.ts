import { useState, useEffect, useCallback, useRef } from "react";
import { IDictionaryEntry, ISubtitleCue } from "../types";
import {
  lookupWord,
  lookupWordWithContext,
  getCachedWord,
} from "../dictionary";
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
  aiProvider: string;
  setAiProvider: (provider: string) => void;
  targetLanguage: string;
  setTargetLanguage: (lang: string) => void;
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
  const [aiProvider, setAiProvider] = useState<string>("mistral");

  // Load provider preference from local storage
  useEffect(() => {
    const savedProvider = localStorage.getItem("stash_subtitle_ai_provider");
    if (savedProvider === "ollama" || savedProvider === "mistral") {
      setAiProvider(savedProvider);
    }
  }, []);

  const [targetLanguage, setTargetLanguage] = useState<string>("zh");

  // Load language preference from local storage
  useEffect(() => {
    const savedLang = localStorage.getItem("stash_subtitle_dict_lang");
    if (savedLang === "en" || savedLang === "zh") {
      setTargetLanguage(savedLang);
    }
  }, []);

  const handleSetTargetLanguage = useCallback((lang: string) => {
    setTargetLanguage(lang);
    localStorage.setItem("stash_subtitle_dict_lang", lang);
  }, []);

  const handleSetAiProvider = useCallback((provider: string) => {
    setAiProvider(provider);
    localStorage.setItem("stash_subtitle_ai_provider", provider);
  }, []);

  const previousAiProvider = useRef(aiProvider);
  const previousTargetLanguage = useRef(targetLanguage);

  // Counter to cancel stale async lookups
  const lookupIdRef = useRef(0);

  // Auto-fetch or load from cache when aiProvider or targetLanguage changes
  useEffect(() => {
    let ignore = false;

    if (
      previousAiProvider.current !== aiProvider ||
      previousTargetLanguage.current !== targetLanguage
    ) {
      previousAiProvider.current = aiProvider;
      previousTargetLanguage.current = targetLanguage;

      if (showDictionary && selectedWord) {
        const context = currentCue?.text || "";
        const cachedEntry = getCachedWord(
          selectedWord,
          context,
          targetLanguage,
          aiProvider
        );

        if (cachedEntry) {
          setDictionary(cachedEntry);
          setIsLoading(false);
        } else {
          setIsLoading(true);
          const fetchWord = async () => {
            try {
              const entry = context
                ? await lookupWordWithContext(
                    selectedWord,
                    context,
                    targetLanguage,
                    aiProvider
                  )
                : await lookupWord(selectedWord, targetLanguage, aiProvider);
              if (!ignore) {
                setDictionary(entry);
              }
            } catch (error) {
              console.error("Dictionary lookup failed:", error);
            } finally {
              if (!ignore) {
                setIsLoading(false);
              }
            }
          };
          fetchWord();
        }
      }
    }

    return () => {
      ignore = true;
    };
  }, [aiProvider, targetLanguage, showDictionary, selectedWord, currentCue]);

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

      // Increment lookup ID to cancel any in-flight requests
      const currentLookupId = ++lookupIdRef.current;

      setSelectedWord(word);
      setShowDictionary(true);

      const context = currentCue?.text || "";
      const cachedEntry = getCachedWord(
        word,
        context,
        targetLanguage,
        aiProvider
      );

      if (cachedEntry) {
        setDictionary(cachedEntry);
        setIsLoading(false);
        return;
      }

      setDictionary(null);
      setIsLoading(true);

      try {
        const entry = context
          ? await lookupWordWithContext(
              word,
              context,
              targetLanguage,
              aiProvider
            )
          : await lookupWord(word, targetLanguage, aiProvider);

        // Only apply result if this is still the latest lookup
        if (lookupIdRef.current === currentLookupId) {
          setDictionary(entry);
        }
      } catch (error) {
        if (lookupIdRef.current === currentLookupId) {
          console.error("Dictionary lookup failed:", error);
          setDictionary(null);
        }
      } finally {
        if (lookupIdRef.current === currentLookupId) {
          setIsLoading(false);
        }
      }
    },
    [targetLanguage, currentCue, onPausePlayer, aiProvider]
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
    aiProvider,
    setAiProvider: handleSetAiProvider,
    targetLanguage,
    setTargetLanguage: handleSetTargetLanguage,
  };
}
