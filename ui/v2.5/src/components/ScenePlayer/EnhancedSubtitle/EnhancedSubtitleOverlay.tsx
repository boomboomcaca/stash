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
  resetFontSizeTrigger?: number; // Increment this to trigger font size reset
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
  resetFontSizeTrigger,
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
  const [dragStartTime, setDragStartTime] = useState(0); // Track when drag started
  const [favoriteWords, setFavoriteWords] = useState<Set<string>>(new Set());
  const [isFavorite, setIsFavorite] = useState(false);
  
  const subtitleRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ y: 0, startY: 0, x: 0, startX: 0, startFontSize: 1.0, hasDeterminedMode: false });
  const lastCueRef = useRef<SubtitleCue | null>(null);
  const autoPauseTriggeredRef = useRef(false);
  
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

  // Mouse drag handlers
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    
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
  }, [isDragging, dragMode]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Touch drag handlers for mobile
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging) return;
    
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
    
    e.preventDefault(); // Prevent scrolling while dragging
  }, [isDragging, dragMode]);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Add global event listeners for drag
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleTouchEnd);
      
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
  }, [isDragging, handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  // Find fullscreen container when entering fullscreen mode
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

    return () => clearTimeout(timer);
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

    const loadSubtitles = async () => {
      try {
        const response = await fetch(subtitleTrack);
        if (response.ok) {
          const content = await response.text();
          const cues = parseVTT(content);
          setParsedSubtitles({ cues });
        }
      } catch (error) {
        console.error('Failed to load subtitles:', error);
        setParsedSubtitles(null);
      }
    };

    loadSubtitles();
  }, [subtitleTrack, parseVTT]);

  // Find current subtitle cue and handle auto-pause
  useEffect(() => {
    if (!parsedSubtitles) {
      setCurrentCue(null);
      return;
    }

    const cue = parsedSubtitles.cues.find(
      c => currentTime >= c.startTime && currentTime <= c.endTime
    );
    
    // Auto-pause logic: pause before subtitle disappears
    if (autoPauseEnabled && onPausePlayer) {
      // When a new cue appears, reset the trigger flag
      if (cue && cue !== lastCueRef.current) {
        autoPauseTriggeredRef.current = false;
        lastCueRef.current = cue;
      }
      
      // If we have a current cue and haven't triggered pause yet
      if (cue && !autoPauseTriggeredRef.current) {
        const timeUntilEnd = cue.endTime - currentTime;
        const pauseThreshold = 0.2; // Pause 0.1 seconds before subtitle ends
        
        if (timeUntilEnd <= pauseThreshold && timeUntilEnd > 0) {
          console.log('🎬 Auto-pausing before subtitle ends');
          onPausePlayer();
          autoPauseTriggeredRef.current = true;
        }
      }
      
      // Clear last cue when no cue is active
      if (!cue) {
        lastCueRef.current = null;
        autoPauseTriggeredRef.current = false;
      }
    }
    
    setCurrentCue(cue || null);
  }, [currentTime, parsedSubtitles, autoPauseEnabled, onPausePlayer]);

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
      hasDeterminedMode: false
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
      hasDeterminedMode: false
    };
  }, [dragPosition.y, fontSize]);

  // Handle AP indicator click to toggle auto-pause (only if not dragged)
  const handleAPClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Only toggle if this was a click (not a drag)
    // Check if drag time was less than 200ms and no significant movement
    const dragDuration = Date.now() - dragStartTime;
    const wasClick = dragDuration < 200 && !dragStartRef.current.hasDeterminedMode;
    
    if (wasClick) {
      const newValue = !autoPauseEnabled;
      setAutoPauseEnabled(newValue);
      localStorage.setItem('enhancedSubtitleAutoPause', newValue.toString());
      console.log('🎬 Auto-pause', newValue ? 'enabled' : 'disabled');
    }
  }, [autoPauseEnabled, dragStartTime]);

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

      // Add the word segment as clickable
      elements.push(
        <span
          key={`word-${index}`}
          className={`subtitle-word ${segment.isSelected ? 'selected' : ''} ${isFavorited ? 'favorited' : ''}`}
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
  }, [currentCue, wordSegments, handleWordClick, detectedLanguage, favoriteWords]);

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

  if (!isVisible || !currentCue) {
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
        className="subtitle-text"
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
        {/* Auto-pause toggle button with drag support */}
        <div 
          className={`drag-indicator ${autoPauseEnabled ? 'auto-pause-active' : ''}`}
          onMouseDown={handleAPMouseDown}
          onTouchStart={handleAPTouchStart}
          onClick={handleAPClick}
          title={autoPauseEnabled ? 'Auto-pause enabled (click to disable)' : 'Auto-pause disabled (click to enable). Drag vertically to move, horizontally to resize.'}
        >
          <span className="drag-dots">
            AP
          </span>
        </div>
        
        {renderSegmentedText}
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
