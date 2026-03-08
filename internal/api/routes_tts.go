package api

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/tts"
)

type ttsRoutes struct{}

func (rs ttsRoutes) Routes() chi.Router {
	r := chi.NewRouter()

	r.Get("/pronounce", rs.Pronounce)

	return r
}

// Pronounce proxies TTS requests to Microsoft Edge TTS API
// Providing high-quality natural voices and better mobile compatibility
func (rs ttsRoutes) Pronounce(w http.ResponseWriter, r *http.Request) {
	// Get query parameters
	text := r.URL.Query().Get("text")
	lang := r.URL.Query().Get("lang")

	if text == "" {
		http.Error(w, "text parameter is required", http.StatusBadRequest)
		return
	}

	// Default language to English (US) if not specified
	if lang == "" {
		lang = "en-US"
	}

	// Handle simple language codes
	// Frontend may send 'en', 'zh', etc.
	if lang == "en" {
		lang = "en-US"
	} else if lang == "zh" {
		lang = "zh-CN"
	}

	// Use Edge TTS engine
	engine := tts.NewEdgeTTS()

	// Set a timeout for the request
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	audioData, err := engine.GetPronunciationAudio(ctx, text, lang)
	if err != nil {
		logger.Errorf("Edge TTS failed: %v", err)
		http.Error(w, "TTS service currently unavailable", http.StatusServiceUnavailable)
		return
	}

	// Set response headers
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400") // Cache for 24 hours
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// Write the audio data
	_, err = w.Write(audioData)
	if err != nil {
		logger.Errorf("Failed to write TTS response: %v", err)
		return
	}

	logger.Debugf("Edge TTS serving: text=%s, lang=%s, size=%d", text, lang, len(audioData))
}
