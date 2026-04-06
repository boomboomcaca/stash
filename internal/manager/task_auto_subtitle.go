package manager

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/subtitle"
	"github.com/stashapp/stash/pkg/txn"
)

// AutoSubtitleJob is a job that generates subtitles for scenes
type AutoSubtitleJob struct {
	SceneIDs        []int
	Language        string
	SkipIfExists    bool
	SubtitleService *subtitle.Service
	Repository      models.Repository
}

// Execute runs the auto subtitle job
func (j *AutoSubtitleJob) Execute(ctx context.Context, progress *job.Progress) error {
	var scenes []*models.Scene
	var err error

	// Get scenes to process
	if len(j.SceneIDs) > 0 {
		// Process specific scenes
		scenes, err = j.getScenesByIDs(ctx, j.SceneIDs)
	} else {
		// Process all scenes without subtitles
		scenes, err = j.getScenesWithoutSubtitles(ctx)
	}

	if err != nil {
		return fmt.Errorf("failed to get scenes: %w", err)
	}

	if len(scenes) == 0 {
		logger.Info("No scenes to process for subtitle generation")
		return nil
	}

	logger.Infof("Processing %d scenes for subtitle generation", len(scenes))
	progress.SetTotal(len(scenes))

	successCount := 0
	failCount := 0

	for i, scene := range scenes {
		if job.IsCancelled(ctx) {
			logger.Info("Subtitle generation cancelled")
			break
		}

		displayName := scene.Title
		if displayName == "" && scene.Path != "" {
			displayName = filepath.Base(scene.Path)
		}
		if displayName == "" {
			displayName = fmt.Sprintf("scene %d", scene.ID)
		}

		progress.SetPercent(float64(i) / float64(len(scenes)))
		progress.ExecuteTask(fmt.Sprintf("Generating subtitle for %s", displayName), func() {
			result, genErr := j.SubtitleService.GenerateSubtitle(ctx, scene, j.Language)
			if genErr != nil {
				logger.Warnf("Failed to generate subtitle for scene %d: %v", scene.ID, genErr)
				failCount++
				return
			}

			if result.Success {
				logger.Infof("Generated subtitle for scene %d: %s", scene.ID, result.SubtitlePath)
				successCount++
			}
		})

		progress.Increment()
	}

	logger.Infof("Subtitle generation complete: %d succeeded, %d failed", successCount, failCount)
	return nil
}

func (j *AutoSubtitleJob) getScenesByIDs(ctx context.Context, ids []int) ([]*models.Scene, error) {
	var scenes []*models.Scene

	err := txn.WithReadTxn(ctx, j.Repository.TxnManager, func(ctx context.Context) error {
		for _, id := range ids {
			scene, err := j.Repository.Scene.Find(ctx, id)
			if err != nil {
				return err
			}
			if scene != nil {
				// Load files to ensure we have the path available for display names and ffmpeg
				if err := scene.LoadFiles(ctx, j.Repository.Scene); err != nil {
					logger.Warnf("Failed to load files for scene %d: %v", scene.ID, err)
				}
				scenes = append(scenes, scene)
			}
		}
		return nil
	})

	return scenes, err
}

func (j *AutoSubtitleJob) getScenesWithoutSubtitles(ctx context.Context) ([]*models.Scene, error) {
	var scenes []*models.Scene

	err := txn.WithReadTxn(ctx, j.Repository.TxnManager, func(ctx context.Context) error {
		// Query all scenes - use PerPageAll to get all results
		perPage := models.PerPageAll
		result, err := j.Repository.Scene.Query(ctx, models.SceneQueryOptions{
			QueryOptions: models.QueryOptions{
				FindFilter: &models.FindFilterType{
					PerPage: &perPage,
				},
				Count: false,
			},
			SceneFilter: &models.SceneFilterType{},
		})
		if err != nil {
			return err
		}

		allScenes, err := result.Resolve(ctx)
		if err != nil {
			return err
		}

		for _, scene := range allScenes {
			// Load files to get the Path
			if err := scene.LoadFiles(ctx, j.Repository.Scene); err != nil {
				logger.Warnf("Failed to load files for scene %d: %v", scene.ID, err)
				continue
			}

			// Check if scene has subtitle
			if !j.SubtitleService.HasSubtitle(scene) {
				scenes = append(scenes, scene)
			}
		}

		return nil
	})

	return scenes, err
}
