import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from 'react-bootstrap';
import { WordSegment, DictionaryEntry, SubtitleCue, SegmentationOptions } from './types';
import { createSegmenter, detectLanguage } from './segmentation';
import { lookupWord } from './dictionary';
import './styles.scss';

interface EnhancedSubtitleOverlayProps {
  currentTime: number;
  subtitleTrack: string | null;
  isVisible: boolean;
  language?: string;
  isFullscreen?: boolean;
  onToggleVisibility: () => void;
  onPause?: () => void;
  onResume?: () => void;
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
  onPause,
  onResume,
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
  const [wasPlayingBeforeDictionary, setWasPlayingBeforeDictionary] = useState(false);
  
  const segmenterRef = useRef(createSegmenter({
    language: detectedLanguage,
    enablePunctuation: false,
    minWordLength: 1
  }));

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
          if (text) text += ' ';
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

  // Find current subtitle cue
  useEffect(() => {
    if (!parsedSubtitles) {
      setCurrentCue(null);
      return;
    }

    const cue = parsedSubtitles.cues.find(
      c => currentTime >= c.startTime && currentTime <= c.endTime
    );
    
    setCurrentCue(cue || null);
  }, [currentTime, parsedSubtitles]);

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

  // Handle word selection
  const handleWordClick = useCallback(async (word: string) => {
    console.log('🔍 Word clicked:', word, 'isFullscreen:', isFullscreen);
    console.log('🔍 Document body:', document.body);
    console.log('🔍 Document fullscreenElement:', document.fullscreenElement);
    console.log('🔍 VJS fullscreen classes:', {
      documentElement: document.documentElement.className,
      vjsFullWindow: document.documentElement.classList.contains('vjs-full-window'),
      vjsFullscreenElements: document.querySelectorAll('.vjs-fullscreen')
    });
    
    setSelectedWord(word);
    setIsLoading(true);
    setShowDictionary(true);
    
    console.log('🔍 Dictionary modal should show:', true);
    
    // Pause video when opening dictionary
    if (onPause) {
      onPause();
      setWasPlayingBeforeDictionary(true);
    }
    
    try {
      const entry = await lookupWord(word, detectedLanguage);
      setDictionary(entry);
    } catch (error) {
      console.error('Dictionary lookup failed:', error);
      setDictionary(null);
    } finally {
      setIsLoading(false);
    }
  }, [detectedLanguage, onPause]);

  // Handle closing dictionary and resume playback if needed
  const handleCloseDictionary = useCallback(() => {
    setShowDictionary(false);
    
    // Resume video if it was playing before dictionary opened
    if (wasPlayingBeforeDictionary && onResume) {
      onResume();
      setWasPlayingBeforeDictionary(false);
    }
  }, [wasPlayingBeforeDictionary, onResume]);

  // Add keydown event listener for ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && showDictionary) {
        handleCloseDictionary();
      }
    };

    if (showDictionary) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [showDictionary, handleCloseDictionary]);

  // Render segmented text with clickable words
  const renderSegmentedText = useMemo(() => {
    if (!currentCue || wordSegments.length === 0) {
      return currentCue?.text || '';
    }

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    wordSegments.forEach((segment, index) => {
      // Add text before this segment
      if (segment.startIndex > lastIndex) {
        const betweenText = currentCue.text.slice(lastIndex, segment.startIndex);
        elements.push(<span key={`between-${index}`}>{betweenText}</span>);
      }

      // Add the word segment as clickable
      elements.push(
        <span
          key={`word-${index}`}
          className={`subtitle-word ${segment.isSelected ? 'selected' : ''}`}
          onClick={() => handleWordClick(segment.word)}
          title={`Click to look up "${segment.word}"`}
        >
          {segment.word}
        </span>
      );

      lastIndex = segment.endIndex;
    });

    // Add any remaining text
    if (lastIndex < currentCue.text.length) {
      elements.push(
        <span key="remaining">{currentCue.text.slice(lastIndex)}</span>
      );
    }

    return elements;
  }, [currentCue, wordSegments, handleWordClick]);

  // Custom modal content for fullscreen compatibility
  const renderCustomModal = () => {
    if (!showDictionary) return null;

    console.log('🔍 Rendering custom modal:', {
      show: showDictionary,
      isFullscreen,
      selectedWord,
      fullscreenContainer: fullscreenContainer?.className,
      documentFullscreenElement: document.fullscreenElement,
      bodyChildren: document.body.children.length,
      documentElement: document.documentElement.classList.toString()
    });
    
    return (
      <div 
        className={`custom-dictionary-modal ${isFullscreen ? 'fullscreen-mode' : ''}`}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: isFullscreen ? 999999 : 1050,
          pointerEvents: 'auto',
          // Additional styles for fullscreen compatibility
          ...(isFullscreen && {
            position: 'absolute',
            inset: 0
          })
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            handleCloseDictionary();
          }
        }}
      >
        <div 
          className="modal-content-custom"
          style={{
            backgroundColor: 'var(--bs-body-bg, white)',
            borderRadius: '0.375rem',
            boxShadow: '0 0.5rem 1rem rgba(0, 0, 0, 0.15)',
            maxWidth: '500px',
            width: '90%',
            maxHeight: '80vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div 
            style={{
              padding: '1rem',
              borderBottom: '1px solid var(--bs-border-color, #dee2e6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <h5 style={{ margin: 0, color: 'var(--bs-body-color, black)' }}>
              Dictionary: {selectedWord}
              {detectedLanguage !== 'en' && (
                <span 
                  className="language-badge"
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem 0.5rem',
                    backgroundColor: 'var(--bs-primary, #0d6efd)',
                    color: 'white',
                    borderRadius: '0.25rem',
                    fontSize: '0.75rem'
                  }}
                >
                  {detectedLanguage}
                </span>
              )}
            </h5>
            <button
              type="button"
              onClick={handleCloseDictionary}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '1.5rem',
                lineHeight: 1,
                color: 'var(--bs-body-color, black)',
                cursor: 'pointer',
                padding: '0.25rem'
              }}
            >
              ×
            </button>
          </div>
          
          {/* Body */}
          <div 
            style={{
              padding: '1rem',
              overflowY: 'auto',
              flex: 1,
              color: 'var(--bs-body-color, black)'
            }}
          >
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <div 
                  style={{
                    width: '2rem',
                    height: '2rem',
                    border: '0.25rem solid var(--bs-primary, #0d6efd)',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                    margin: '0 auto 1rem'
                  }}
                />
                <p>Looking up word...</p>
              </div>
            ) : dictionary ? (
              <div className="dictionary-content">
                {dictionary.pronunciation && (
                  <div style={{ marginBottom: '1rem' }}>
                    <strong>Pronunciation:</strong> {dictionary.pronunciation}
                  </div>
                )}
                
                {dictionary.definitions.map((def, index) => (
                  <div key={index} style={{ marginBottom: '1rem' }}>
                    <div style={{ marginBottom: '0.5rem' }}>
                      <span 
                        style={{
                          padding: '0.25rem 0.5rem',
                          backgroundColor: 'var(--bs-secondary, #6c757d)',
                          color: 'white',
                          borderRadius: '0.25rem',
                          fontSize: '0.75rem'
                        }}
                      >
                        {def.partOfSpeech}
                      </span>
                    </div>
                    <div style={{ marginTop: '0.5rem' }}>{def.meaning}</div>
                    {def.examples && def.examples.length > 0 && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <em>Examples:</em>
                        <ul style={{ marginTop: '0.25rem' }}>
                          {def.examples.map((example, i) => (
                            <li key={i}>{example}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
                
                {dictionary.etymology && (
                  <div style={{ marginTop: '1rem' }}>
                    <strong>Etymology:</strong> {dictionary.etymology}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <p>No definition found for "{selectedWord}"</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (!isVisible || !currentCue) {
    return null;
  }

  // Subtitle content without modal
  const subtitleContent = (
    <div className={`enhanced-subtitle-overlay ${isFullscreen ? 'fullscreen-mode' : ''}`}>
      <div className="subtitle-text">
        {renderSegmentedText}
      </div>
    </div>
  );

  // Dictionary modal portal - render to appropriate container based on mode
  const getModalContainer = () => {
    if (!showDictionary) return null;
    
    // In fullscreen mode, try to render to the fullscreen container
    if (isFullscreen && fullscreenContainer) {
      console.log('📍 Rendering modal to fullscreen container:', fullscreenContainer);
      return fullscreenContainer;
    }
    
    // For video.js fullscreen, check if we have a special container
    if (isFullscreen && document.documentElement.classList.contains('vjs-full-window')) {
      const vjsContainer = document.querySelector('.video-js.vjs-fullscreen') as HTMLElement;
      if (vjsContainer) {
        console.log('📍 Rendering modal to video.js fullscreen container:', vjsContainer);
        return vjsContainer;
      }
    }
    
    // Check for standard fullscreen element
    if (document.fullscreenElement) {
      console.log('📍 Rendering modal to document.fullscreenElement:', document.fullscreenElement);
      return document.fullscreenElement as HTMLElement;
    }
    
    // Fallback to document.body
    console.log('📍 Rendering modal to document.body (fallback)');
    return document.body;
  };
  
  const modalContainer = getModalContainer();
  const dictionaryModalPortal = modalContainer ? createPortal(renderCustomModal(), modalContainer) : null;

  // Render subtitle content with portal in fullscreen mode
  if (isFullscreen && fullscreenContainer) {
    return (
      <>
        {createPortal(subtitleContent, fullscreenContainer)}
        {dictionaryModalPortal}
      </>
    );
  }

  // Render normally for non-fullscreen mode
  return (
    <>
      {subtitleContent}
      {dictionaryModalPortal}
    </>
  );
};
