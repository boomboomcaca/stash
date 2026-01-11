package manager

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/fsutil"
	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/txn"
)

type RotateVideoJob struct {
	Scene       *models.Scene
	Rotation    int // 90, 180, 270
	TxnManager  models.TxnManager
	SceneFinder models.SceneReaderWriter
}

func (j *RotateVideoJob) Execute(ctx context.Context, progress *job.Progress) error {
	if j.Rotation != 90 && j.Rotation != 180 && j.Rotation != 270 {
		return fmt.Errorf("invalid rotation value: %d (must be 90, 180, or 270)", j.Rotation)
	}

	scene := j.Scene
	var inputPath string

	// Load files within a transaction
	if err := txn.WithReadTxn(ctx, j.TxnManager, func(ctx context.Context) error {
		if err := scene.LoadFiles(ctx, j.SceneFinder); err != nil {
			return fmt.Errorf("loading scene files: %w", err)
		}

		files := scene.Files.List()
		if len(files) == 0 {
			return fmt.Errorf("scene has no files")
		}

		inputPath = files[0].Path
		return nil
	}); err != nil {
		return err
	}

	logger.Infof("Rotating video %s by %d degrees", inputPath, j.Rotation)
	progress.SetTotal(100)

	// Create temp output file
	dir := filepath.Dir(inputPath)
	ext := filepath.Ext(inputPath)
	baseName := filepath.Base(inputPath)
	baseName = baseName[:len(baseName)-len(ext)]
	tempOutput := filepath.Join(dir, fmt.Sprintf("%s_rotated%s", baseName, ext))

	// Get transpose filter value based on rotation
	var transposeFilter string
	switch j.Rotation {
	case 90:
		transposeFilter = "transpose=1" // 90 clockwise
	case 180:
		transposeFilter = "transpose=1,transpose=1" // 180
	case 270:
		transposeFilter = "transpose=2" // 90 counter-clockwise (270 clockwise)
	}

	progress.Increment()
	progress.SetPercent(5)

	// Build ffmpeg command
	encoder := instance.FFMpeg
	if encoder == nil {
		return fmt.Errorf("ffmpeg not configured")
	}

	// Try VAAPI hardware acceleration first, fallback to software encoding
	var args []string
	useVAAPI := j.checkVAAPISupport()

	if useVAAPI {
		logger.Info("Using VAAPI hardware acceleration for video rotation")
		// VAAPI hardware accelerated encoding
		args = []string{
			"-vaapi_device", "/dev/dri/renderD128",
			"-i", inputPath,
			"-vf", fmt.Sprintf("%s,format=nv12,hwupload", transposeFilter),
			"-c:v", "h264_vaapi",
			"-c:a", "copy",
			"-y",
			tempOutput,
		}
	} else {
		logger.Info("Using software encoding for video rotation")
		// Software encoding fallback
		args = []string{
			"-i", inputPath,
			"-vf", transposeFilter,
			"-c:a", "copy",
			"-y",
			tempOutput,
		}
	}

	logger.Debugf("Running ffmpeg with args: %v", args)

	cmd := encoder.Command(ctx, args)
	output, err := cmd.CombinedOutput()
	if err != nil {
		logger.Errorf("ffmpeg error: %s", string(output))
		// Clean up temp file if it exists
		os.Remove(tempOutput)
		return fmt.Errorf("ffmpeg error: %w - %s", err, string(output))
	}

	progress.SetPercent(80)

	// Replace original file with rotated file
	// First, backup original (rename to .bak)
	backupPath := inputPath + ".bak"
	if err := os.Rename(inputPath, backupPath); err != nil {
		os.Remove(tempOutput)
		return fmt.Errorf("failed to backup original file: %w", err)
	}

	// Move temp to original location
	if err := fsutil.SafeMove(tempOutput, inputPath); err != nil {
		// Try to restore backup
		os.Rename(backupPath, inputPath)
		return fmt.Errorf("failed to move rotated file: %w", err)
	}

	// Remove backup
	os.Remove(backupPath)

	progress.SetPercent(90)

	// Trigger rescan of the scene
	if err := j.rescanScene(ctx); err != nil {
		logger.Warnf("Failed to trigger rescan after rotation: %v", err)
	}

	progress.SetPercent(100)
	logger.Infof("Successfully rotated video %s by %d degrees", inputPath, j.Rotation)

	return nil
}

// checkVAAPISupport checks if VAAPI hardware acceleration is available
func (j *RotateVideoJob) checkVAAPISupport() bool {
	// Check if VAAPI device exists
	if _, err := os.Stat("/dev/dri/renderD128"); err != nil {
		logger.Debug("VAAPI device /dev/dri/renderD128 not found")
		return false
	}

	logger.Debug("VAAPI device found, hardware acceleration available")
	return true
}

func (j *RotateVideoJob) rescanScene(ctx context.Context) error {
	mgr := GetInstance()
	if mgr == nil {
		return fmt.Errorf("manager instance not available")
	}

	scene := j.Scene
	if err := scene.LoadFiles(ctx, j.SceneFinder); err != nil {
		return err
	}

	files := scene.Files.List()
	if len(files) == 0 {
		return nil
	}

	path := files[0].Path

	// Trigger scan for this specific path
	_, err := mgr.Scan(ctx, ScanMetadataInput{
		Paths: []string{path},
		ScanMetadataOptions: config.ScanMetadataOptions{
			Rescan: true,
		},
	})
	return err
}
