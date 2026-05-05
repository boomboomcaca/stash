package subtitle

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"

	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/ollama"
)

// WhisperJSONResponse defines the JSON schema we get from the Whisper API
type WhisperJSONResponse struct {
	Segments []WhisperSegment `json:"segments"`
}

type WhisperSegment struct {
	Start float64       `json:"start"`
	End   float64       `json:"end"`
	Text  string        `json:"text"`
	Words []WhisperWord `json:"words"`
}

type WhisperWord struct {
	Word        string  `json:"word"`
	Start       float64 `json:"start"`
	End         float64 `json:"end"`
	Probability float64 `json:"probability"`
}

// formatTimestamp converts seconds to HH:MM:SS,mmm
func formatTimestamp(ts float64) string {
	hours := int(ts / 3600)
	minutes := int(ts/60) % 60
	seconds := int(ts) % 60
	millis := int((ts - float64(int(ts))) * 1000)
	return fmt.Sprintf("%02d:%02d:%02d,%03d", hours, minutes, seconds, millis)
}

// generateAIAlignedSRT orchestrates Mistral AI text chunking and SRT sequence assembly
func generateAIAlignedSRT(ctx context.Context, whisperJSON string) (string, error) {
	var resp WhisperJSONResponse
	if err := json.Unmarshal([]byte(whisperJSON), &resp); err != nil {
		return "", fmt.Errorf("failed to parse Whisper JSON: %w", err)
	}

	if len(resp.Segments) == 0 {
		return "", nil
	}

	var finalSRT strings.Builder
	lineOffset := 1

	var currentSegments []WhisperSegment
	var currentChars int

	llmService := ollama.NewService(nil)
	sysPrompt := "You are a professional subtitle generation engine. Your ONLY job is to output the EXACT text provided by the user, but carefully broken into natural lines using newline characters. DO NOT add any conversational fluff. DO NOT change words or punctuation. Maintain original intent strictly."

	processChunk := func(segs []WhisperSegment) error {
		var allWords []WhisperWord
		var originalText strings.Builder

		for _, seg := range segs {
			for _, w := range seg.Words {
				allWords = append(allWords, w)
				originalText.WriteString(w.Word)
			}
		}

		cleanText := strings.TrimSpace(originalText.String())
		if cleanText == "" {
			return nil
		}

		prompt := fmt.Sprintf("Here is a continuous stream of text from an audio transcript:\n\n%s\n\nPlease rewrite this exact text. Your only task is to insert natural line breaks (using the ENTER key) where it makes the most sense grammatically and rhythmically for subtitles. Maximum ~10 words per line, occasionally shorter for dramatic effect. Do NOT alter spelling, case, or add markdown formatting. Just the raw text.", cleanText)

		aiText, err := llmService.GenerateMistral(ctx, prompt, sysPrompt)
		if err != nil {
			return err
		}

		// Ensure any literal "\n" emitted by confused models is treated as actual newline
		aiText = strings.ReplaceAll(aiText, "\\n", "\n")

		chunkSRT, nextLineOff := alignTextToWordsChunk(allWords, aiText, lineOffset)
		finalSRT.WriteString(chunkSRT)
		lineOffset = nextLineOff
		return nil
	}

	for _, seg := range resp.Segments {
		currentSegments = append(currentSegments, seg)
		currentChars += len(seg.Text)

		// 2000 characters is a safe chunk size (~300-400 words)
		if currentChars > 2000 {
			if err := processChunk(currentSegments); err != nil {
				logger.Errorf("AI alignment chunk failed (Mistral error), falling back to basic split for this chunk: %v", err)
				chunkSRT, nextLineOff := fallbackToBasicSRTChunk(currentSegments, lineOffset)
				finalSRT.WriteString(chunkSRT)
				lineOffset = nextLineOff
			}
			currentSegments = nil
			currentChars = 0
		}
	}

	// Process remaining chunks
	if len(currentSegments) > 0 {
		if err := processChunk(currentSegments); err != nil {
			logger.Errorf("AI alignment chunk failed (Mistral error), falling back to basic split for this chunk: %v", err)
			chunkSRT, _ := fallbackToBasicSRTChunk(currentSegments, lineOffset)
			finalSRT.WriteString(chunkSRT)
		}
	}

	return finalSRT.String(), nil
}

func cleanForMatch(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

func alignTextToWordsChunk(words []WhisperWord, aiChunkedText string, startLineOffset int) (string, int) {
	lines := strings.Split(aiChunkedText, "\n")
	var srtOutput strings.Builder
	wordIdx := 0
	lineIndex := startLineOffset

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		lineClean := cleanForMatch(line)
		if len(lineClean) == 0 {
			continue
		}

		charsCollected := 0
		startTs := float64(-1)
		endTs := float64(-1)

		for wordIdx < len(words) {
			w := words[wordIdx]
			if startTs == -1 {
				startTs = w.Start
			}
			if w.End > endTs {
				endTs = w.End
			}

			wClean := cleanForMatch(w.Word)
			charsCollected += len(wClean)
			wordIdx++

			// Consumed enough words matching this line
			if charsCollected >= len(lineClean)-2 {
				break
			}
		}

		if startTs != -1 && endTs != -1 && startTs <= endTs {
			fmt.Fprintf(&srtOutput, "%d\n", lineIndex)
			fmt.Fprintf(&srtOutput, "%s --> %s\n", formatTimestamp(startTs), formatTimestamp(endTs))
			srtOutput.WriteString(line + "\n\n")
			lineIndex++
		}
	}

	return srtOutput.String(), lineIndex
}

// generateBasicSRT parses Whisper JSON and generates basic SRT word by word or segment by segment natively
func generateBasicSRT(whisperJSON string) string {
	var resp WhisperJSONResponse
	if err := json.Unmarshal([]byte(whisperJSON), &resp); err != nil {
		return ""
	}
	res, _ := fallbackToBasicSRTChunk(resp.Segments, 1)
	return res
}

func fallbackToBasicSRTChunk(segs []WhisperSegment, startLineOffset int) (string, int) {
	var srtOutput strings.Builder
	idx := startLineOffset
	for _, seg := range segs {
		startTs := formatTimestamp(seg.Start)
		endTs := formatTimestamp(seg.End)
		text := strings.TrimSpace(seg.Text)
		if text != "" {
			fmt.Fprintf(&srtOutput, "%d\n", idx)
			fmt.Fprintf(&srtOutput, "%s --> %s\n", startTs, endTs)
			srtOutput.WriteString(text + "\n\n")
			idx++
		}
	}
	return srtOutput.String(), idx
}
