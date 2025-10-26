import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from 'react-bootstrap';
import { WordSegment, DictionaryEntry, SubtitleCue, SegmentationOptions } from './types';
import { createSegmenter, detectLanguage } from './segmentation';
import { lookupWord, lookupWordWithContext } from './dictionary';
import { playWordPronunciation } from './pronunciation';
import { getFavorites, addFavorite, removeFavorite, checkFavorite, FavoriteWord } from './favorites';
import './styles.scss';

interface EnhancedSubtitleOverlayProps {
  currentTime: number;
  subtitleTrack: string | null;
  isVisible: boolean;
  language?: string;
  isFullscreen?: boolean;
  onToggleVisibility: () => void;
  onPausePlayer?: () => void;
  getPlayerPaused?: () => boolean; // Get player paused state
  resetFontSizeTrigger?: number; // Increment this to trigger font size reset
  onSubtitlesLoaded?: (cues: SubtitleCue[]) => void; // 字幕加载完成回调
  onCurrentCueChange?: (index: number) => void; // 当前字幕索引变化回调
  onAPDoubleClick?: () => void; // AP图标双击回调
  onPlay?: () => void; // Resume playback
  onSeekToCue?: (cueIndex: number) => void; // Seek to specific cue
  onGetPlayer?: () => any; // Get video player instance
  onNavigationRef?: (ref: any) => void; // Callback to expose navigation functions
}

interface ParsedSubtitle {
  cues: SubtitleCue[];
}

export const EnhancedSubtitleOverlay: React.FC<EnhancedSubtitleOverlayProps> = ({
  currentTime,
  subtitleTrack,
  isVisible,
  language = 'en',
  isFullscreen = false,
  onToggleVisibility,
  onPausePlayer,
  getPlayerPaused,
  resetFontSizeTrigger,
  onSubtitlesLoaded,
  onCurrentCueChange,
  onAPDoubleClick,
  onPlay,
  onSeekToCue,
  onGetPlayer,
  onNavigationRef,
}) => {
  const [parsedSubtitles, setParsedSubtitles] = useState<ParsedSubtitle | null>(null);
  const [currentCue, setCurrentCue] = useState<SubtitleCue | null>(null);
  const [wordSegments, setWordSegments] = useState<WordSegment[]>([]);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [dictionary, setDictionary] = useState<DictionaryEntry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showDictionary, setShowDictionary] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState<string>(language);
  const [fullscreenContainer, setFullscreenContainer] = useState<HTMLElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPosition, setDragPosition] = useState({ y: 0 });
  const [lastSavedPosition, setLastSavedPosition] = useState({ y: 0 });
  const [fontSize, setFontSize] = useState(1.0); // Scale factor for font size
  const [lastSavedFontSize, setLastSavedFontSize] = useState(1.0);
  const [dragMode, setDragMode] = useState<'position' | 'size'>('position');
  const [autoPauseEnabled, setAutoPauseEnabled] = useState(false);
  const [isAutoPaused, setIsAutoPaused] = useState(false); // Track if currently auto-paused
  const [isPlayerPaused, setIsPlayerPaused] = useState(false); // Track player pause state
  const [dragStartTime, setDragStartTime] = useState(0); // Track when drag started
  const [favoriteWords, setFavoriteWords] = useState<Set<string>>(new Set());
  const [isFavorite, setIsFavorite] = useState(false);
  
  // Word navigation mode state
  const [selectedWordIndex, setSelectedWordIndex] = useState<number>(-1);
  const [isInWordNavigationMode, setIsInWordNavigationMode] = useState(false);
  
  const subtitleRef = useRef<HTMLDivElement>(null);
  const subtitleCacheRef = useRef<Map<string, SubtitleCue[]>>(new Map()); // 字幕缓存
  const dragStartRef = useRef({ y: 0, startY: 0, x: 0, startX: 0, startFontSize: 1.0, hasDeterminedMode: false, initialX: 0, initialY: 0 });
  const lastCueRef = useRef<SubtitleCue | null>(null);
  const autoPauseTriggeredRef = useRef(false);
  const lastPausedStateRef = useRef<boolean | null>(null);
  const userResumedPlaybackRef = useRef(false);
  const lastCurrentTimeRef = useRef<number>(0); // Track last currentTime to detect replays
  const lastUpArrowPressRef = useRef<number>(0);
  const lastDownArrowPressRef = useRef<number>(0);
  
  // AP图标双击检测
  const lastAPClickTimeRef = useRef<number>(0);
  const APDoubleClickTimeoutRef = useRef<number | null>(null);
  
  const segmenterRef = useRef(createSegmenter({
    language: detectedLanguage,
    enablePunctuation: false,
    minWordLength: 1
  }));
  
  // Load saved position, font size, and auto-pause setting from localStorage
  useEffect(() => {
    const savedPosition = localStorage.getItem('enhancedSubtitlePosition');
    if (savedPosition) {
      try {
        const position = JSON.parse(savedPosition);
        setDragPosition(position);
        setLastSavedPosition(position);
      } catch (error) {
        console.error('Failed to parse saved subtitle position:', error);
      }
    }

    const savedFontSize = localStorage.getItem('enhancedSubtitleFontSize');
    if (savedFontSize) {
      try {
        const size = parseFloat(savedFontSize);
        if (size >= 0.5 && size <= 3.0) { // Reasonable bounds for font size
          setFontSize(size);
          setLastSavedFontSize(size);
        }
      } catch (error) {
        console.error('Failed to parse saved subtitle font size:', error);
      }
    }

    const savedAutoPause = localStorage.getItem('enhancedSubtitleAutoPause');
    if (savedAutoPause) {
      try {
        setAutoPauseEnabled(savedAutoPause === 'true');
      } catch (error) {
        console.error('Failed to parse saved auto-pause setting:', error);
      }
    }
  }, []);

  // Save position and font size to localStorage when they change
  useEffect(() => {
    const saveTimer = setTimeout(() => {
      if (dragPosition.y !== lastSavedPosition.y) {
        localStorage.setItem('enhancedSubtitlePosition', JSON.stringify(dragPosition));
        setLastSavedPosition(dragPosition);
      }
    }, 500); // Debounce saves

    return () => clearTimeout(saveTimer);
  }, [dragPosition, lastSavedPosition]);

  useEffect(() => {
    const saveTimer = setTimeout(() => {
      if (fontSize !== lastSavedFontSize) {
        localStorage.setItem('enhancedSubtitleFontSize', fontSize.toString());
        setLastSavedFontSize(fontSize);
      }
    }, 500); // Debounce saves

    return () => clearTimeout(saveTimer);
  }, [fontSize, lastSavedFontSize]);

  // Save auto-pause setting to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('enhancedSubtitleAutoPause', autoPauseEnabled.toString());
  }, [autoPauseEnabled]);

  // Load favorites on mount
  useEffect(() => {
    const loadFavorites = async () => {
      const favorites = await getFavorites();
      const favSet = new Set(favorites.map(f => `${f.word}:${f.language}`));
      setFavoriteWords(favSet);
    };
    loadFavorites();
  }, []);

  // ✅ 清理 PronunciationService 缓存（组件卸载时）
  useEffect(() => {
    return () => {
      // 组件卸载时清理音频缓存
      try {
        // 使用动态导入避免require问题
        import('./pronunciation').then(({ pronunciationService }) => {
          if (pronunciationService && typeof pronunciationService.clearCache === 'function') {
            pronunciationService.clearCache();
          }
        }).catch((error) => {
          console.warn('Failed to clear pronunciation cache:', error);
        });
      } catch (error) {
        console.warn('Failed to clear pronunciation cache:', error);
      }
    };
  }, []);

  // Check if selected word is favorite
  useEffect(() => {
    if (selectedWord) {
      const key = `${selectedWord}:${detectedLanguage}`;
      setIsFavorite(favoriteWords.has(key));
    } else {
      setIsFavorite(false);
    }
  }, [selectedWord, detectedLanguage, favoriteWords]);

  // Reset font size when trigger changes
  useEffect(() => {
    if (resetFontSizeTrigger !== undefined && resetFontSizeTrigger > 0) {
      setFontSize(1.0);
    }
  }, [resetFontSizeTrigger]);

  // ✅ Mouse drag handlers - 使用 useRef 避免依赖更新
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const deltaX = e.clientX - dragStartRef.current.x;
    const deltaY = e.clientY - dragStartRef.current.y;
    
    // Auto-determine drag mode based on initial movement direction
    if (!dragStartRef.current.hasDeterminedMode) {
      const threshold = 10; // Minimum pixels to determine direction
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      
      if (absX > threshold || absY > threshold) {
        // Determine mode based on which direction has more movement
        const newMode = absX > absY ? 'size' : 'position';
        setDragMode(newMode);
        dragStartRef.current.hasDeterminedMode = true;
      } else {
        return; // Wait for more movement to determine direction
      }
    }
    
    if (dragMode === 'position') {
      // Vertical dragging for position
      const newY = dragStartRef.current.startY + deltaY;
      
      // Limit dragging to reasonable bounds
      const containerHeight = window.innerHeight;
      const minY = -containerHeight * 0.85; // Can move up to 85% of screen height (near top)
      const maxY = containerHeight * 0.2;   // Can move down to 20% of screen height
      
      setDragPosition({ y: Math.max(minY, Math.min(maxY, newY)) });
    } else if (dragMode === 'size') {
      // Horizontal dragging for font size (left = larger, right = smaller)
      const sensitivity = 0.003; // Adjust sensitivity as needed
      const newSize = dragStartRef.current.startFontSize - (deltaX * sensitivity);
      
      // Limit font size to reasonable bounds
      const minSize = 0.5;
      const maxSize = 3.0;
      
      setFontSize(Math.max(minSize, Math.min(maxSize, newSize)));
    }
  }, [dragMode]); // ✅ 移除 isDragging 依赖

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    // 重置拖动模式标志，确保下次点击检测正常工作
    dragStartRef.current.hasDeterminedMode = false;
  }, []);

  // ✅ Touch drag handlers for mobile - 使用 useRef 避免依赖更新
  // 🚀 性能优化：不再调用 preventDefault，使用 CSS touch-action 代替
  const handleTouchMove = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    const deltaX = touch.clientX - dragStartRef.current.x;
    const deltaY = touch.clientY - dragStartRef.current.y;
    
    // Auto-determine drag mode based on initial movement direction
    if (!dragStartRef.current.hasDeterminedMode) {
      const threshold = 15; // Slightly higher threshold for touch
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      
      if (absX > threshold || absY > threshold) {
        // Determine mode based on which direction has more movement
        const newMode = absX > absY ? 'size' : 'position';
        setDragMode(newMode);
        dragStartRef.current.hasDeterminedMode = true;
      } else {
        return; // Wait for more movement to determine direction
      }
    }
    
    if (dragMode === 'position') {
      // Vertical dragging for position
      const newY = dragStartRef.current.startY + deltaY;
      
      const containerHeight = window.innerHeight;
      const minY = -containerHeight * 0.85; // Can move up to 85% of screen height (near top)
      const maxY = containerHeight * 0.2;   // Can move down to 20% of screen height
      
      setDragPosition({ y: Math.max(minY, Math.min(maxY, newY)) });
    } else if (dragMode === 'size') {
      // Horizontal dragging for font size (left = larger, right = smaller)
      const sensitivity = 0.003;
      const newSize = dragStartRef.current.startFontSize - (deltaX * sensitivity);
      
      const minSize = 0.5;
      const maxSize = 3.0;
      
      setFontSize(Math.max(minSize, Math.min(maxSize, newSize)));
    }
    
    // 🚀 移除 preventDefault() - 使用 CSS touch-action: none 代替，性能更好
  }, [dragMode]); // ✅ 移除 isDragging 依赖

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    // 重置拖动模式标志，确保下次点击检测正常工作
    dragStartRef.current.hasDeterminedMode = false;
  }, []);

  // ✅ Add global event listeners for drag - 修复依赖问题
  // 🚀 性能优化：移动端使用 passive 事件监听器以提升性能
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // 🚀 移动端性能优化：使用 passive 监听器，只在必要时调用 preventDefault
      document.addEventListener('touchmove', handleTouchMove, { passive: true });
      document.addEventListener('touchend', handleTouchEnd, { passive: true });
      
      // Add dragging class to body to prevent text selection
      document.body.classList.add('subtitle-dragging');
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.body.classList.remove('subtitle-dragging');
      };
    }
    // ✅ 只依赖 isDragging，callback 函数现在稳定不变
  }, [isDragging, handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  // ✅ Find fullscreen container when entering fullscreen mode
  useEffect(() => {
    if (!isFullscreen) {
      setFullscreenContainer(null);
      return;
    }

    // Look for video.js fullscreen container
    const findFullscreenContainer = () => {
      // Check for video.js fullscreen class on html element
      if (document.documentElement.classList.contains('vjs-full-window')) {
        // Find the video player container in fullscreen mode
        const playerContainer = document.querySelector('.video-js.vjs-fullscreen') as HTMLElement;
        if (playerContainer) {
          setFullscreenContainer(playerContainer);
          return;
        }
      }
      
      // Check for standard fullscreen element
      const fullscreenElement = document.fullscreenElement as HTMLElement;
      if (fullscreenElement) {
        setFullscreenContainer(fullscreenElement);
        return;
      }
      
      // Fallback: look for any element with fullscreen-related classes
      const vjsFullscreen = document.querySelector('.vjs-fullscreen') as HTMLElement;
      if (vjsFullscreen) {
        setFullscreenContainer(vjsFullscreen);
        return;
      }

      // If no specific container found, use body as fallback
      setFullscreenContainer(document.body);
    };

    // Try to find container immediately
    findFullscreenContainer();

    // If not found, try again after a short delay (for animation completion)
    const timer = setTimeout(findFullscreenContainer, 100);

    // ✅ 清理函数
    return () => {
      clearTimeout(timer);
      // 退出全屏时确保清理容器引用
      setFullscreenContainer(null);
    };
  }, [isFullscreen]);

  // Parse VTT subtitles
  const parseVTT = useCallback((vttContent: string): SubtitleCue[] => {
    const cues: SubtitleCue[] = [];
    const lines = vttContent.split('\n');
    
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      
      // Skip WEBVTT header and empty lines
      if (line === 'WEBVTT' || line === '' || line.startsWith('NOTE')) {
        i++;
        continue;
      }
      
      // Look for timestamp line
      const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/);
      if (timeMatch) {
        const startTime = parseVTTTime(timeMatch[1]);
        const endTime = parseVTTTime(timeMatch[2]);
        
        i++; // Move to text lines
        let text = '';
        
        // Collect text lines until empty line or next timestamp
        while (i < lines.length && lines[i].trim() !== '' && 
               !lines[i].match(/^\d{2}:\d{2}:\d{2}\.\d{3} -->/)) {
          if (text) text += '\n';
          text += lines[i].trim().replace(/<[^>]*>/g, ''); // Remove HTML tags
          i++;
        }
        
        if (text) {
          cues.push({ startTime, endTime, text });
        }
      } else {
        i++;
      }
    }
    
    return cues;
  }, []);

  // Parse VTT timestamp to seconds
  const parseVTTTime = (timeStr: string): number => {
    const [hours, minutes, seconds] = timeStr.split(':');
    return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds);
  };

  // Load and parse subtitle file
  useEffect(() => {
    if (!subtitleTrack) {
      setParsedSubtitles(null);
      return;
    }

    // ✅ 使用 AbortController 来取消请求
    const abortController = new AbortController();
    let cancelled = false;

    // ✅ 添加防抖机制，避免频繁重新加载
    const loadSubtitles = async () => {
      try {
        // ✅ 检查缓存
        const cachedCues = subtitleCacheRef.current.get(subtitleTrack);
        if (cachedCues) {
          if (cancelled) return;
          setParsedSubtitles({ cues: cachedCues });
          if (onSubtitlesLoaded) {
            onSubtitlesLoaded(cachedCues);
          }
          return;
        }

        const response = await fetch(subtitleTrack, {
          signal: abortController.signal
        });
        
        if (cancelled) return; // 防止状态更新
        
        if (response.ok) {
          const content = await response.text();
          
          if (cancelled) return; // 防止状态更新
          
          const cues = parseVTT(content);
          
          // ✅ 缓存字幕数据
          subtitleCacheRef.current.set(subtitleTrack, cues);
          
          setParsedSubtitles({ cues });
          // 通知父组件字幕已加载
          if (onSubtitlesLoaded) {
            onSubtitlesLoaded(cues);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          console.log('Subtitle loading cancelled');
          return;
        }
        console.error('Failed to load subtitles:', error);
        if (!cancelled) {
          setParsedSubtitles(null);
        }
      }
    };

    // ✅ 添加小延迟，避免频繁重新加载
    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        loadSubtitles();
      }
    }, 100);

    // ✅ 清理函数：取消请求和超时
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [subtitleTrack, parseVTT, onSubtitlesLoaded]);

  // Find current subtitle cue and handle auto-pause
  // 🚀 性能优化：使用 useMemo 缓存字幕查找结果，避免每次 currentTime 更新都重新查找
  const currentCueData = useMemo(() => {
    if (!parsedSubtitles) {
      return { cue: null, cueIndex: -1 };
    }

    // 使用二分查找优化查找性能（假设字幕按时间排序）
    const cues = parsedSubtitles.cues;
    let cue: SubtitleCue | null = null;
    let cueIndex = -1;

    // 简单的线性查找，但只在必要时执行
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (currentTime >= c.startTime && currentTime <= c.endTime) {
        cue = c;
        cueIndex = i;
        break;
      }
      // 提前退出：如果当前时间小于字幕开始时间，后面的都不用查了
      if (currentTime < c.startTime) {
        break;
      }
    }
    
    return { cue, cueIndex };
  }, [currentTime, parsedSubtitles]);

  // Track player pause state for AP label color
  useEffect(() => {
    if (getPlayerPaused) {
      const paused = getPlayerPaused();
      setIsPlayerPaused(paused);
    }
  }, [currentTime, getPlayerPaused]); // Update when currentTime changes to catch pause state changes

  useEffect(() => {
    if (!parsedSubtitles) {
      setCurrentCue(null);
      return;
    }

    const { cue, cueIndex } = currentCueData;
    
    // Auto-pause logic: pause before subtitle disappears
    if (autoPauseEnabled && onPausePlayer && getPlayerPaused) {
      const isPaused = getPlayerPaused();
      
      // When a new cue appears, reset the flags
      // Compare by content (startTime, endTime, text) instead of reference to avoid false positives
      const isSameCue = cue && lastCueRef.current && 
        cue.startTime === lastCueRef.current.startTime && 
        cue.endTime === lastCueRef.current.endTime &&
        cue.text === lastCueRef.current.text;
      
      // 🔄 检测重播当前字幕的情况（双击重播）
      // 如果是同一个字幕，但时间跳转回了字幕开始附近（误差0.5秒内），说明是重播
      if (cue && isSameCue && autoPauseTriggeredRef.current) {
        const timeDiff = currentTime - lastCurrentTimeRef.current;
        const isNearStart = Math.abs(currentTime - cue.startTime) < 0.5;
        
        // 如果时间倒退了（或跳转），且当前时间接近字幕开始位置，说明是重播
        if (timeDiff < -0.5 && isNearStart) {
          console.log('🔄 Detected replay of current subtitle (double-tap), resetting auto-pause flags', {
            currentTime,
            cueStartTime: cue.startTime,
            timeDiff,
            lastTime: lastCurrentTimeRef.current
          });
          autoPauseTriggeredRef.current = false;
          userResumedPlaybackRef.current = false;
          setIsAutoPaused(false);
        }
      }
      
      if (cue && !isSameCue) {
        console.log('🎬 New subtitle detected, resetting auto-pause flags', {
          newCue: { start: cue.startTime, end: cue.endTime, text: cue.text.substring(0, 20) },
          oldCue: lastCueRef.current ? { start: lastCueRef.current.startTime, end: lastCueRef.current.endTime } : null
        });
        autoPauseTriggeredRef.current = false;
        userResumedPlaybackRef.current = false;
        setIsAutoPaused(false); // Clear auto-paused state for new subtitle
        lastCueRef.current = cue;
        lastPausedStateRef.current = isPaused; // Initialize paused state for new subtitle
      }
      
      // Detect if user manually resumed playback BEFORE we try to auto-pause
      // This checks if the player state changed from paused to playing
      if (lastPausedStateRef.current === true && isPaused === false) {
        // Only mark as user-resumed if we previously auto-paused
        // This prevents normal playback from being flagged as "user resumed"
        if (autoPauseTriggeredRef.current) {
          console.log('🎬 User manually resumed playback after auto-pause, disabling auto-pause for current subtitle');
          userResumedPlaybackRef.current = true;
          setIsAutoPaused(false); // Clear auto-paused state when user resumes
          lastPausedStateRef.current = isPaused;
          // Don't check for auto-pause in this cycle since user just resumed
          return;
        }
      }
      
      lastPausedStateRef.current = isPaused;
      
      // If we have a current cue and haven't triggered pause yet and user hasn't manually resumed
      if (cue && !autoPauseTriggeredRef.current && !userResumedPlaybackRef.current && !isPaused) {
        const timeUntilEnd = cue.endTime - currentTime;
        const pauseThreshold = 0.3; // Pause 0.3 seconds before subtitle ends
        
        if (timeUntilEnd <= pauseThreshold && timeUntilEnd > 0) {
          console.log('🎬 Auto-pausing before subtitle ends');
          onPausePlayer();
          autoPauseTriggeredRef.current = true;
          setIsAutoPaused(true); // Set auto-paused state when pausing
        }
      }
      
      // Clear last cue when no cue is active
      if (!cue) {
        lastCueRef.current = null;
        autoPauseTriggeredRef.current = false;
        userResumedPlaybackRef.current = false;
        setIsAutoPaused(false); // Clear auto-paused state when no subtitle
      }
    }
    
    // 🚀 性能优化：只在字幕真正变化时才更新状态，避免不必要的重渲染
    const isSameCueContent = cue && currentCue && 
      cue.startTime === currentCue.startTime && 
      cue.endTime === currentCue.endTime &&
      cue.text === currentCue.text;
    
    if (!isSameCueContent) {
      setCurrentCue(cue || null);
      
      // 通知父组件当前字幕索引变化
      if (onCurrentCueChange) {
        onCurrentCueChange(cueIndex);
      }
    }
    
    // 更新上一次的时间，用于检测时间跳转（重播）
    lastCurrentTimeRef.current = currentTime;
  }, [currentCueData, autoPauseEnabled, onPausePlayer, getPlayerPaused, onCurrentCueChange, currentCue, currentTime]);

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
        minWordLength: 1
      });
    }

    const segments = segmenterRef.current.segmentText(currentCue.text);
    setWordSegments(segments);
  }, [currentCue, detectedLanguage]);

  // Handle word pronunciation
  const handlePronunciation = useCallback(async (word: string) => {
    try {
      await playWordPronunciation(word, detectedLanguage);
    } catch (error) {
      console.error('Failed to play pronunciation:', error);
    }
  }, [detectedLanguage]);

  // Handle word selection
  const handleWordClick = useCallback(async (word: string) => {
    // Pause the player when looking up a word
    if (onPausePlayer) {
      onPausePlayer();
    }
    
    setSelectedWord(word);
    setIsLoading(true);
    setShowDictionary(true);
    
    try {
      // Use the current subtitle text as context for better word explanation
      const context = currentCue?.text || '';
      console.log('🔍 Looking up word with context:', { word, context, language: detectedLanguage });
      
      // Use contextual lookup if we have context, otherwise fallback to regular lookup
      const entry = context 
        ? await lookupWordWithContext(word, context, detectedLanguage)
        : await lookupWord(word, detectedLanguage);
        
      setDictionary(entry);
    } catch (error) {
      console.error('Dictionary lookup failed:', error);
      setDictionary(null);
    } finally {
      setIsLoading(false);
    }
  }, [detectedLanguage, currentCue, onPausePlayer]);

  // Handle word selection via keyboard (Enter/OK key)
  const handleWordSelection = useCallback(async () => {
    if (selectedWordIndex >= 0 && selectedWordIndex < wordSegments.length && wordSegments[selectedWordIndex]) {
      const selectedWordText = wordSegments[selectedWordIndex].word;
      await handleWordClick(selectedWordText);
    }
  }, [selectedWordIndex, wordSegments, handleWordClick]);

  // Handle entering word navigation mode
  const enterWordNavigationMode = useCallback(() => {
    if (wordSegments.length > 0) {
      setIsInWordNavigationMode(true);
      setSelectedWordIndex(0); // Select first word
      // Pause playback
      if (onPausePlayer) {
        onPausePlayer();
      }
      console.log('🎯 Entered word navigation mode');
    }
  }, [wordSegments, onPausePlayer]);

  // Handle exiting word navigation mode
  const exitWordNavigationMode = useCallback(() => {
    setIsInWordNavigationMode(false);
    setSelectedWordIndex(-1);
    // Resume playback
    if (onPlay) {
      onPlay();
    }
    console.log('🚪 Exited word navigation mode');
  }, [onPlay]);

  // Navigate to next word
  const navigateToNextWord = useCallback(() => {
    if (selectedWordIndex < wordSegments.length - 1) {
      setSelectedWordIndex(selectedWordIndex + 1);
    }
  }, [selectedWordIndex, wordSegments.length]);

  // Navigate to previous word
  const navigateToPreviousWord = useCallback(() => {
    if (selectedWordIndex > 0) {
      setSelectedWordIndex(selectedWordIndex - 1);
    }
  }, [selectedWordIndex]);

  // Update word navigation when cue changes
  useEffect(() => {
    if (isInWordNavigationMode) {
      setSelectedWordIndex(0); // Reset to first word when cue changes
    }
  }, [currentCue, isInWordNavigationMode]);
  
  // Expose navigation functions to parent via callback (placed after function definitions)
  useEffect(() => {
    if (onNavigationRef) {
      onNavigationRef({
        enterWordNavigationMode,
        exitWordNavigationMode,
        navigateToNextWord,
        navigateToPreviousWord,
        handleWordSelection,
        isInWordNavigationMode,
        parsedSubtitles,
        getCurrentCueIndex: () => {
          if (currentCue && parsedSubtitles) {
            return parsedSubtitles.cues.findIndex(c => 
              c.startTime === currentCue.startTime && 
              c.endTime === currentCue.endTime && 
              c.text === currentCue.text
            );
          }
          return -1;
        },
        onGetPlayer,
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
    currentCue,
    parsedSubtitles,
    onGetPlayer,
  ]);

  // Handle AP indicator mouse down - start drag
  const handleAPMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDragStartTime(Date.now());
    setIsDragging(true);
    setDragMode('position'); // Default to position initially
    
    dragStartRef.current = {
      y: e.clientY,
      startY: dragPosition.y,
      x: e.clientX,
      startX: 0,
      startFontSize: fontSize,
      hasDeterminedMode: false,
      initialX: e.clientX,
      initialY: e.clientY
    };
    
    e.preventDefault();
  }, [dragPosition.y, fontSize]);

  // Handle AP indicator touch start - start drag
  const handleAPTouchStart = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    setDragStartTime(Date.now());
    setIsDragging(true);
    setDragMode('position'); // Default to position initially
    
    dragStartRef.current = {
      y: touch.clientY,
      startY: dragPosition.y,
      x: touch.clientX,
      startX: 0,
      startFontSize: fontSize,
      hasDeterminedMode: false,
      initialX: touch.clientX,
      initialY: touch.clientY
    };
  }, [dragPosition.y, fontSize]);

  // Handle AP indicator click to toggle auto-pause (only if not dragged)
  const handleAPClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Only toggle if this was a click (not a drag)
    // Check if drag time was less than 200ms and no significant movement
    const dragDuration = Date.now() - dragStartTime;
    const deltaX = Math.abs(e.clientX - dragStartRef.current.initialX);
    const deltaY = Math.abs(e.clientY - dragStartRef.current.initialY);
    const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    // 更严格的点击检测：时间短、移动距离小、且没有确定拖动模式
    const wasClick = dragDuration < 200 && totalMovement < 10 && !dragStartRef.current.hasDeterminedMode;
    
    if (wasClick) {
      const now = Date.now();
      const timeSinceLastClick = now - lastAPClickTimeRef.current;
      
      // 检测双击（300ms内的第二次点击）
      if (timeSinceLastClick < 300 && timeSinceLastClick > 0) {
        // 双击AP图标
        console.log('🎬 AP图标双击 - 临时显示控制栏');
        if (onAPDoubleClick) {
          onAPDoubleClick();
        }
        
        // 清除计时器和重置点击时间
        if (APDoubleClickTimeoutRef.current) {
          clearTimeout(APDoubleClickTimeoutRef.current);
          APDoubleClickTimeoutRef.current = null;
        }
        lastAPClickTimeRef.current = 0;
        
        // 双击后不执行单击的切换AP功能
        return;
      }
      
      // 记录点击时间
      lastAPClickTimeRef.current = now;
      
      // 清除之前的单击计时器
      if (APDoubleClickTimeoutRef.current) {
        clearTimeout(APDoubleClickTimeoutRef.current);
      }
      
      // 等待可能的双击
      APDoubleClickTimeoutRef.current = window.setTimeout(() => {
        // 单击：切换AP功能
        // 如果 AP 当前是启用状态（绿色或红色），点击后关闭到灰色
        // 如果 AP 当前是灰色，点击后启用
        if (autoPauseEnabled) {
          // 关闭 AP 到灰色状态
          setAutoPauseEnabled(false);
          setIsAutoPaused(false); // 清除自动暂停状态
          localStorage.setItem('enhancedSubtitleAutoPause', 'false');
          console.log('🎬 Auto-pause disabled (turned to gray)');
        } else {
          // 从灰色启用 AP
          setAutoPauseEnabled(true);
          localStorage.setItem('enhancedSubtitleAutoPause', 'true');
          console.log('🎬 Auto-pause enabled (turned to green/red)');
        }
        
        APDoubleClickTimeoutRef.current = null;
      }, 300);
    }
  }, [autoPauseEnabled, dragStartTime, onAPDoubleClick]);

  // Toggle favorite for selected word
  const toggleFavorite = useCallback(async () => {
    if (!selectedWord) return;
    
    const key = `${selectedWord}:${detectedLanguage}`;
    const newIsFavorite = !isFavorite;
    
    if (newIsFavorite) {
      // Add to favorites
      const success = await addFavorite(selectedWord, detectedLanguage);
      if (success) {
        setFavoriteWords(prev => new Set(prev).add(key));
        setIsFavorite(true);
        console.log('⭐ Added to favorites:', selectedWord);
      }
    } else {
      // Remove from favorites
      const success = await removeFavorite(selectedWord, detectedLanguage);
      if (success) {
        setFavoriteWords(prev => {
          const newSet = new Set(prev);
          newSet.delete(key);
          return newSet;
        });
        setIsFavorite(false);
        console.log('☆ Removed from favorites:', selectedWord);
      }
    }
  }, [selectedWord, detectedLanguage, isFavorite]);


  // Render segmented text with clickable words
  const renderSegmentedText = useMemo(() => {
    if (!currentCue || wordSegments.length === 0) {
      // If no segments, render text with line breaks
      return currentCue?.text.split('\n').map((line, idx, arr) => (
        <React.Fragment key={idx}>
          {line}
          {idx < arr.length - 1 && <br />}
        </React.Fragment>
      )) || '';
    }

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    // Helper function to render text with line breaks
    const renderTextWithBreaks = (text: string, keyPrefix: string) => {
      const lines = text.split('\n');
      return lines.flatMap((line, idx) => {
        const parts: React.ReactNode[] = [<span key={`${keyPrefix}-${idx}`}>{line}</span>];
        if (idx < lines.length - 1) {
          parts.push(<br key={`${keyPrefix}-br-${idx}`} />);
        }
        return parts;
      });
    };

    wordSegments.forEach((segment, index) => {
      // Add text before this segment
      if (segment.startIndex > lastIndex) {
        const betweenText = currentCue.text.slice(lastIndex, segment.startIndex);
        elements.push(...renderTextWithBreaks(betweenText, `between-${index}`));
      }

      // Check if word is favorited
      const wordKey = `${segment.word}:${detectedLanguage}`;
      const isFavorited = favoriteWords.has(wordKey);
      
      // Check if word is currently selected in navigation mode
      const isSelectedInNav = isInWordNavigationMode && index === selectedWordIndex;

      // Add the word segment as clickable
      elements.push(
        <span
          key={`word-${index}`}
          className={`subtitle-word ${segment.isSelected ? 'selected' : ''} ${isSelectedInNav ? 'navigation-selected' : ''} ${isFavorited ? 'favorited' : ''}`}
          onClick={() => handleWordClick(segment.word)}
          title={isFavorited ? `⭐ "${segment.word}" (favorited)` : `Click to look up "${segment.word}"`}
        >
          {segment.word}
        </span>
      );

      lastIndex = segment.endIndex;
    });

    // Add any remaining text
    if (lastIndex < currentCue.text.length) {
      elements.push(
        ...renderTextWithBreaks(currentCue.text.slice(lastIndex), 'remaining')
      );
    }

    return elements;
  }, [currentCue, wordSegments, handleWordClick, detectedLanguage, favoriteWords, isInWordNavigationMode, selectedWordIndex]);

  // Dictionary modal content - compact mode only
  const renderDictionaryModal = () => (
    <Modal 
      show={showDictionary} 
      onHide={() => setShowDictionary(false)}
      className={`dictionary-modal ${isFullscreen ? 'fullscreen-dictionary' : ''}`}
      centered
      container={isFullscreen && fullscreenContainer ? fullscreenContainer : undefined}
    >
      <Modal.Header closeButton>
        <Modal.Title style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="word-text">{selectedWord}</span>
          <button
            className={`favorite-toggle-btn ${isFavorite ? 'favorited' : ''}`}
            onClick={toggleFavorite}
            title={isFavorite ? '取消收藏' : '添加到收藏'}
            style={{
              padding: '2px 6px',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '1.1rem',
              background: 'transparent',
              color: isFavorite ? '#ff6b35' : '#999',
              transition: 'all 0.2s ease',
            }}
          >
            {isFavorite ? '⭐' : '☆'}
          </button>
          {detectedLanguage !== 'en' && (
            <span className="language-badge">{detectedLanguage}</span>
          )}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
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
                  {dictionary.pronunciation && index === 0 && (
                    <span 
                      className="phonetic clickable" 
                      onClick={() => selectedWord && handlePronunciation(selectedWord)}
                      title="点击播放发音"
                    >
                      /{dictionary.pronunciation}/
                    </span>
                  )}
                </div>
                <div className="meaning">
                  {def.meaning.split('\n').map((line, lineIndex) => (
                    <p key={lineIndex} className="meaning-line">
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-3">
            <p className="mb-0 text-muted">未找到释义</p>
          </div>
        )}
      </Modal.Body>
    </Modal>
  );

  if (!isVisible) {
    return null;
  }

  const subtitleContent = (
    <div 
      ref={subtitleRef}
      className={`enhanced-subtitle-overlay ${isFullscreen ? 'fullscreen-mode' : ''} ${isDragging ? 'dragging' : ''}`}
      style={{
        transform: `translateX(-50%) translateY(${dragPosition.y}px)`,
      }}
    >
      <div 
        className={`subtitle-text ${!currentCue ? 'no-content' : ''}`}
        title={
          isDragging 
            ? (dragMode === 'size' ? `Resizing... (${Math.round(fontSize * 100)}%)` : "Moving...") 
            : "Use AP button to drag or resize, 'R' key to reset size"
        }
        style={{
          fontSize: `${fontSize * (isFullscreen ? 2.6 : 1.9)}rem`,
          transition: isDragging ? 'none' : 'font-size 0.2s ease'
        }}
      >
        {/* Auto-pause toggle button with drag support - 增强字幕开启时一直显示 */}
        <div 
          className={`drag-indicator ${autoPauseEnabled ? 'auto-pause-active' : ''} ${isAutoPaused ? 'auto-pause-paused' : ''}`}
          onMouseDown={handleAPMouseDown}
          onTouchStart={handleAPTouchStart}
          onClick={handleAPClick}
          title={isAutoPaused ? 'Auto-paused (click or press space to resume)' : autoPauseEnabled ? 'Auto-pause enabled (click to disable)' : 'Auto-pause disabled (click to enable). Drag vertically to move, horizontally to resize.'}
        >
          <span className="drag-dots">
            AP
          </span>
        </div>
        
        {/* 只有在有字幕内容时才显示字幕文本 */}
        {currentCue && renderSegmentedText}
      </div>
      
      {/* Font size indicator */}
      {(isDragging && dragMode === 'size') && (
        <div className="font-size-indicator">
          {Math.round(fontSize * 100)}%
        </div>
      )}
      
      {renderDictionaryModal()}
    </div>
  );

  // Render with portal in fullscreen mode
  if (isFullscreen && fullscreenContainer) {
    return createPortal(subtitleContent, fullscreenContainer);
  }

  // Render normally for non-fullscreen mode
  return subtitleContent;
};
