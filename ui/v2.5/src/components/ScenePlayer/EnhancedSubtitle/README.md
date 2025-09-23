# Enhanced Subtitle System

This enhanced subtitle system provides advanced features for language learning and accessibility, including word segmentation, interactive word selection, and dictionary lookup.

## Features

### 🎯 Core Features
- **Word Segmentation**: Intelligent word splitting for multiple languages (English, Chinese, Japanese, Korean, etc.)
- **Interactive Word Selection**: Click on any word to get its definition
- **Dictionary Lookup**: Comprehensive dictionary with definitions, pronunciations, and examples
- **Centered Display**: Subtitles appear in the center of the video for better visibility
- **Multi-language Support**: Automatic language detection and appropriate segmentation

### 🎮 Controls
- **'C' key**: Toggle enhanced subtitles on/off
- **Click words**: Open dictionary lookup
- **Hide button**: Temporarily hide enhanced subtitles

### 🌍 Language Support
- **Latin-based**: English, Spanish, French, German, etc.
- **Chinese**: Character-based segmentation
- **Japanese**: Hiragana/Katakana/Kanji support
- **Korean**: Space-based segmentation
- **Russian**: Cyrillic alphabet support

### 📚 Dictionary Features
- **Multiple definitions** with parts of speech
- **Pronunciation** guides (when available)
- **Usage examples**
- **Etymology** information
- **Offline fallback** for common words
- **Fast caching** for repeated lookups

## Technical Architecture

### Components
- `EnhancedSubtitleOverlay`: Main UI component that displays segmented subtitles
- `WordSegmenter`: Handles text segmentation for different languages
- `DictionaryService`: Manages word lookups and caching
- `Types`: TypeScript definitions for all data structures

### API Integration
- **Free Dictionary API**: Primary source for English definitions
- **Fallback System**: Local definitions for common words
- **Caching**: Intelligent caching to minimize API calls

### Styling
- **Dark theme** integration with existing Stash UI
- **Responsive design** for mobile and desktop
- **Smooth animations** for better user experience
- **Accessibility** features for screen readers

## Usage Examples

### Basic Usage
The enhanced subtitles automatically activate when subtitles are available for a video. Simply click on any word to get its definition.

### Keyboard Shortcuts
- Press 'C' to toggle enhanced subtitles
- Use existing video controls (space for play/pause, etc.)

### Language Learning
Perfect for language learners:
1. Watch content in your target language
2. Click on unfamiliar words for instant definitions
3. Learn pronunciation and usage examples
4. Build vocabulary through contextual learning

## Configuration

The system automatically detects the subtitle language and applies appropriate segmentation rules. No manual configuration is required.

## Performance

- **Lazy loading**: Dictionary data is loaded on-demand
- **Efficient caching**: Frequently used words are cached locally
- **Minimal overhead**: Text segmentation is optimized for performance
- **Progressive enhancement**: Falls back gracefully if APIs are unavailable

## Browser Support

Compatible with all modern browsers that support:
- ES6+ JavaScript
- CSS Grid and Flexbox
- Fetch API
- Local Storage

## Future Enhancements

Potential improvements for future versions:
- **Offline dictionary** support
- **Custom word lists** and vocabulary tracking
- **Translation** integration
- **Speech synthesis** for pronunciation
- **Machine learning** for better segmentation
- **User preferences** for segmentation options
