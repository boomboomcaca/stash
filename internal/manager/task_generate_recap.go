package manager

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
)

// GenerateRecapTask produces a narrated plot-recap (解说) derivative video for a
// scene: it transcribes/understands the source, asks an LLM (via the configured
// recap service) for a condensed narration script keyed to source cues, picks
// the matching clips, dubs the narration, and cuts+concatenates+muxes them into
// a sidecar "<name>.<lang>-recap.mp4" capped at a target length. The original
// video is left untouched.
//
// Phase 0: this task is wired end-to-end (queued from the generate job, surfaced
// in the GraphQL/UI) but only logs — the recapScene pipeline is filled in next.
type GenerateRecapTask struct {
	repository models.Repository
	Scene      models.Scene
	Overwrite  bool
	// Language overrides the configured recap target language for this run.
	// Empty means fall back to config.GetRecapTargetLanguage.
	Language string
	// Voice overrides the configured recap narrator voice for this run.
	// Empty means fall back to config.GetRecapVoice.
	Voice string
}

func (t *GenerateRecapTask) GetDescription() string {
	return fmt.Sprintf("Generating recap for %s", t.Scene.Path)
}

// recapTargetLang resolves the recap target language: an explicit per-run
// Language wins, otherwise the configured default.
func (t *GenerateRecapTask) recapTargetLang() string {
	if t.Language != "" {
		return t.Language
	}
	return config.GetInstance().GetRecapTargetLanguage()
}

// required reports whether a recap should be generated for this scene. It is
// called within the generate job's read transaction.
func (t *GenerateRecapTask) required(ctx context.Context) bool {
	f := t.Scene.Files.Primary()
	if f == nil {
		return false
	}
	if t.Overwrite {
		return true
	}
	// skip if a recap file already exists
	if _, err := os.Stat(recapOutputPath(f.Path, t.recapTargetLang())); err == nil {
		return false
	}
	return true
}

func (t *GenerateRecapTask) Start(ctx context.Context) {
	if err := t.repository.WithReadTxn(ctx, func(ctx context.Context) error {
		return t.Scene.LoadPrimaryFile(ctx, t.repository.File)
	}); err != nil {
		logger.Errorf("[recap] error loading primary file for scene %d: %v", t.Scene.ID, err)
		return
	}

	f := t.Scene.Files.Primary()
	if f == nil {
		return
	}

	// Phase 0 placeholder: the recapScene pipeline (transcript -> narration
	// script -> clip plan -> dub -> cut/concat/mux) is filled in next.
	logger.Infof("[recap] would generate %s recap for %s (duration %.0fs)",
		t.recapTargetLang(), f.Path, f.Duration)
}

// recapOutputPath returns "<dir>/<name>.<lang>-recap.mp4".
func recapOutputPath(videoPath, lang string) string {
	ext := filepath.Ext(videoPath)
	return strings.TrimSuffix(videoPath, ext) + "." + lang + "-recap.mp4"
}
