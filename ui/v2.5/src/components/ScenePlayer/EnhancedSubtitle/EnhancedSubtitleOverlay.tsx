import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button, Card, Modal } from 'react-bootstrap';
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
    setSelectedWord(word);
    setIsLoading(true);
    setShowDictionary(true);
    
    try {
      const entry = await lookupWord(word, detectedLanguage);
      setDictionary(entry);
    } catch (error) {
      console.error('Dictionary lookup failed:', error);
      setDictionary(null);
    } finally {
      setIsLoading(false);
    }
  }, [detectedLanguage]);

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

  // Dictionary modal content
  const renderDictionaryModal = () => (
    <Modal 
      show={showDictionary} 
      onHide={() => setShowDictionary(false)}
      className="dictionary-modal"
      centered
    >
      <Modal.Header closeButton>
        <Modal.Title>
          Dictionary: {selectedWord}
          {detectedLanguage !== 'en' && (
            <span className="language-badge">{detectedLanguage}</span>
          )}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isLoading ? (
          <div className="text-center p-4">
            <div className="spinner-border" role="status">
              <span className="sr-only">Loading...</span>
            </div>
          </div>
        ) : dictionary ? (
          <div className="dictionary-content">
            {dictionary.pronunciation && (
              <div className="pronunciation mb-3">
                <strong>Pronunciation:</strong> {dictionary.pronunciation}
              </div>
            )}
            
            {dictionary.definitions.map((def, index) => (
              <div key={index} className="definition mb-3">
                <div className="part-of-speech">
                  <span className="badge badge-secondary">{def.partOfSpeech}</span>
                </div>
                <div className="meaning mt-2">{def.meaning}</div>
                {def.examples && def.examples.length > 0 && (
                  <div className="examples mt-2">
                    <em>Examples:</em>
                    <ul className="mt-1">
                      {def.examples.map((example, i) => (
                        <li key={i}>{example}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
            
            {dictionary.etymology && (
              <div className="etymology mt-3">
                <strong>Etymology:</strong> {dictionary.etymology}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center p-4">
            <p>No definition found for "{selectedWord}"</p>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={() => setShowDictionary(false)}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );

  if (!isVisible || !currentCue) {
    return null;
  }

  const subtitleContent = (
    <div className={`enhanced-subtitle-overlay ${isFullscreen ? 'fullscreen-mode' : ''}`}>
      <Card className="subtitle-card">
        <Card.Body className="subtitle-content">
          <div className="subtitle-text">
            {renderSegmentedText}
          </div>
          <div className="subtitle-controls mt-2">
            <Button 
              variant="outline-light" 
              size="sm"
              onClick={onToggleVisibility}
              title="Hide enhanced subtitles"
            >
              Hide
            </Button>
            <span className="language-indicator">
              Language: {detectedLanguage}
            </span>
          </div>
        </Card.Body>
      </Card>
      
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
