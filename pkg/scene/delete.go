package scene

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/stashapp/stash/pkg/file"
	"github.com/stashapp/stash/pkg/file/video"
	"github.com/stashapp/stash/pkg/fsutil"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/models/paths"
)

// FileDeleter is an extension of file.Deleter that handles deletion of scene files.
type FileDeleter struct {
	*file.Deleter

	FileNamingAlgo models.HashAlgorithm
	Paths          *paths.Paths
}

// MarkGeneratedFiles marks for deletion the generated files for the provided scene.
// Generated files bypass trash and are permanently deleted since they can be regenerated.
func (d *FileDeleter) MarkGeneratedFiles(scene *models.Scene) error {
	sceneHash := scene.GetHash(d.FileNamingAlgo)

	if sceneHash == "" {
		return nil
	}

	markersFolder := filepath.Join(d.Paths.Generated.Markers, sceneHash)

	exists, _ := fsutil.FileExists(markersFolder)
	if exists {
		if err := d.DirsWithoutTrash([]string{markersFolder}); err != nil {
			return err
		}
	}

	var files []string

	streamPreviewPath := d.Paths.Scene.GetVideoPreviewPath(sceneHash)
	exists, _ = fsutil.FileExists(streamPreviewPath)
	if exists {
		files = append(files, streamPreviewPath)
	}

	streamPreviewImagePath := d.Paths.Scene.GetWebpPreviewPath(sceneHash)
	exists, _ = fsutil.FileExists(streamPreviewImagePath)
	if exists {
		files = append(files, streamPreviewImagePath)
	}

	transcodePath := d.Paths.Scene.GetTranscodePath(sceneHash)
	exists, _ = fsutil.FileExists(transcodePath)
	if exists {
		files = append(files, transcodePath)
	}

	spritePath := d.Paths.Scene.GetSpriteImageFilePath(sceneHash)
	exists, _ = fsutil.FileExists(spritePath)
	if exists {
		files = append(files, spritePath)
	}

	vttPath := d.Paths.Scene.GetSpriteVttFilePath(sceneHash)
	exists, _ = fsutil.FileExists(vttPath)
	if exists {
		files = append(files, vttPath)
	}

	heatmapPath := d.Paths.Scene.GetInteractiveHeatmapPath(sceneHash)
	exists, _ = fsutil.FileExists(heatmapPath)
	if exists {
		files = append(files, heatmapPath)
	}

	return d.FilesWithoutTrash(files)
}

// MarkMarkerFiles deletes generated files for a scene marker with the
// provided scene and timestamp.
// Generated files bypass trash and are permanently deleted since they can be regenerated.
func (d *FileDeleter) MarkMarkerFiles(scene *models.Scene, seconds int) error {
	videoPath := d.Paths.SceneMarkers.GetVideoPreviewPath(scene.GetHash(d.FileNamingAlgo), seconds)
	imagePath := d.Paths.SceneMarkers.GetWebpPreviewPath(scene.GetHash(d.FileNamingAlgo), seconds)
	screenshotPath := d.Paths.SceneMarkers.GetScreenshotPath(scene.GetHash(d.FileNamingAlgo), seconds)

	var files []string

	exists, _ := fsutil.FileExists(videoPath)
	if exists {
		files = append(files, videoPath)
	}

	exists, _ = fsutil.FileExists(imagePath)
	if exists {
		files = append(files, imagePath)
	}

	exists, _ = fsutil.FileExists(screenshotPath)
	if exists {
		files = append(files, screenshotPath)
	}

	return d.FilesWithoutTrash(files)
}

// Destroy deletes a scene and its associated relationships from the
// database.
func (s *Service) Destroy(ctx context.Context, scene *models.Scene, fileDeleter *FileDeleter, deleteGenerated, deleteFile, deleteSubtitles, destroyFileEntry bool) error {
	// Only delete markers if we're actually deleting the scene
	// If only deleting subtitles or generated files, keep the markers
	if deleteFile {
		mqb := s.MarkerRepository
		markers, err := mqb.FindBySceneID(ctx, scene.ID)
		if err != nil {
			return err
		}

		for _, m := range markers {
			if err := DestroyMarker(ctx, scene, m, mqb, fileDeleter); err != nil {
				return err
			}
		}
	}

	if deleteFile {
		if err := s.deleteFiles(ctx, scene, fileDeleter, deleteSubtitles); err != nil {
			return err
		}
	} else if destroyFileEntry {
		// destroy the file DB entries without removing files from disk - only
		// when we did NOT already delete the files above (deleteFiles already
		// destroys the entries, so running this too would double-destroy and
		// roll back the whole delete).
		if err := s.destroyFileEntries(ctx, scene); err != nil {
			return err
		}
	}

	// Delete subtitle files independently if requested. Only meaningful when we
	// are not deleting the whole file, which already sweeps its subtitles.
	if deleteSubtitles && !deleteFile {
		if err := s.deleteSubtitlesOnly(ctx, scene, fileDeleter); err != nil {
			return err
		}
	}

	if deleteGenerated {
		if err := fileDeleter.MarkGeneratedFiles(scene); err != nil {
			return err
		}
	}

	// Only destroy the scene record if we're actually deleting the scene file
	// If only deleting subtitles or generated files, keep the scene record
	if deleteFile {
		if err := s.Repository.Destroy(ctx, scene.ID); err != nil {
			return err
		}
	}

	return nil
}

// deleteFiles deletes files from the database and file system
func (s *Service) deleteFiles(ctx context.Context, scene *models.Scene, fileDeleter *FileDeleter, deleteSubtitles bool) error {
	if err := scene.LoadFiles(ctx, s.Repository); err != nil {
		return err
	}

	for _, f := range scene.Files.List() {
		// only delete files where there is no other associated scene
		otherScenes, err := s.Repository.FindByFileID(ctx, f.ID)
		if err != nil {
			return err
		}

		if len(otherScenes) > 1 {
			// other scenes associated, don't remove
			continue
		}

		const deleteFile = true
		logger.Info("Deleting scene file: ", f.Path)
		if err := file.Destroy(ctx, s.File, f, fileDeleter.Deleter, deleteFile); err != nil {
			return err
		}

		// don't delete files in zip archives
		if f.ZipFileID == nil {
			// delete funscript file if it exists
			funscriptPath := video.GetFunscriptPath(f.Path)
			funscriptExists, _ := fsutil.FileExists(funscriptPath)
			if funscriptExists {
				if err := fileDeleter.Files([]string{funscriptPath}); err != nil {
					return err
				}
			}
		}

		// delete caption/subtitle records (and files, when not inside a zip
		// archive) if deleteSubtitles is true
		if deleteSubtitles {
			if err := s.deleteCaptionFiles(ctx, f, fileDeleter); err != nil {
				return err
			}
		}
	}

	return nil
}

// deleteSubtitlesOnly deletes only subtitle files without deleting the video files
func (s *Service) deleteSubtitlesOnly(ctx context.Context, scene *models.Scene, fileDeleter *FileDeleter) error {
	if err := scene.LoadFiles(ctx, s.Repository); err != nil {
		return err
	}

	for _, f := range scene.Files.List() {
		// delete caption/subtitle records and files if they exist
		if err := s.deleteCaptionFiles(ctx, f, fileDeleter); err != nil {
			return err
		}
	}

	return nil
}

// deleteCaptionFiles deletes caption/subtitle files associated with a video
// file and removes their caption records
func (s *Service) deleteCaptionFiles(ctx context.Context, f models.File, fileDeleter *FileDeleter) error {
	// Get captions from database
	captions, err := s.File.GetCaptions(ctx, f.Base().ID)
	if err != nil {
		logger.Warnf("Error getting captions for file %s: %v", f.Base().Path, err)
		return nil // don't fail deletion if we can't get captions
	}

	var captionFiles []string

	// caption files inside zip archives cannot be deleted from disk; only
	// their caption records are cleared below
	if f.Base().ZipFileID == nil {
		for _, caption := range captions {
			captionPath := caption.Path(f.Base().Path)
			exists, _ := fsutil.FileExists(captionPath)
			if exists {
				captionFiles = append(captionFiles, captionPath)
				logger.Infof("Marking caption file for deletion: %s", captionPath)
			}
		}

		// Also check for common subtitle file patterns that might not be in database
		videoPath := f.Base().Path
		videoDir := filepath.Dir(videoPath)
		videoBase := strings.TrimSuffix(filepath.Base(videoPath), filepath.Ext(videoPath))

		// Check for common subtitle extensions using the centralized SubtitleExts list
		for _, extWithoutDot := range video.SubtitleExts {
			ext := "." + extWithoutDot
			// Check for files with same basename + language code + extension
			pattern := filepath.Join(videoDir, videoBase+".*"+ext)
			matches, err := filepath.Glob(pattern)
			if err == nil {
				for _, match := range matches {
					// Deliberately broad: "<base>.*<ext>" also matches the derived
					// captions ("<base>.zh-dub.zh.srt") and other related subtitles.
					// Deleting a video with its files should sweep ALL subtitles tied
					// to it, leaving no orphans behind.
					// Check if this file is not already marked for deletion
					alreadyMarked := false
					for _, marked := range captionFiles {
						if marked == match {
							alreadyMarked = true
							break
						}
					}
					if !alreadyMarked {
						captionFiles = append(captionFiles, match)
						logger.Infof("Marking additional subtitle file for deletion: %s", match)
					}
				}
			}

			// Also check for files with same basename + extension (no language code)
			simplePattern := filepath.Join(videoDir, videoBase+ext)
			exists, _ := fsutil.FileExists(simplePattern)
			if exists {
				alreadyMarked := false
				for _, marked := range captionFiles {
					if marked == simplePattern {
						alreadyMarked = true
						break
					}
				}
				if !alreadyMarked {
					captionFiles = append(captionFiles, simplePattern)
					logger.Infof("Marking simple subtitle file for deletion: %s", simplePattern)
				}
			}
		}

		// Also sweep the intermediate tagged dub-scripts ("<base>.<lang>.srt.dub")
		// generated alongside the captions; they end in ".dub" (not a subtitle
		// extension) so the loop above misses them, and they would otherwise be
		// orphaned when the video and its subtitles are deleted.
		//
		// Match by reading the directory rather than with filepath.Glob: videoBase
		// is a user-controlled filename that commonly contains glob metacharacters
		// (e.g. "Show [1080p]"), which turn the pattern into a character class —
		// silently matching a *different* video's dub scripts while leaving this
		// video's own behind, or erroring out entirely on an unbalanced bracket.
		dubPrefix := videoBase + "."
		if entries, derr := os.ReadDir(videoDir); derr == nil {
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				name := entry.Name()
				if !strings.HasPrefix(name, dubPrefix) || !strings.HasSuffix(name, ".dub") {
					continue
				}
				match := filepath.Join(videoDir, name)
				alreadyMarked := false
				for _, marked := range captionFiles {
					if marked == match {
						alreadyMarked = true
						break
					}
				}
				if !alreadyMarked {
					captionFiles = append(captionFiles, match)
					logger.Infof("Marking intermediate dub-script for deletion: %s", match)
				}
			}
		}

		if len(captionFiles) > 0 {
			if err := fileDeleter.Files(captionFiles); err != nil {
				return fmt.Errorf("marking caption files for deletion: %w", err)
			}
		}
	}

	// remove the caption records as well, otherwise the player keeps offering
	// the deleted tracks until the next scan runs CleanCaptions
	if len(captions) > 0 {
		if err := s.File.UpdateCaptions(ctx, f.Base().ID, nil); err != nil {
			return fmt.Errorf("clearing captions for file %s: %w", f.Base().Path, err)
		}
	}

	// the deleted files may also be referenced by other video files sharing
	// the same basename (e.g. dub sidecar scenes). Include caption paths from
	// db records even when the file is already gone from disk, so stale
	// records on those files are cleared too.
	dissociatePaths := captionFiles
	for _, caption := range captions {
		captionPath := caption.Path(f.Base().Path)
		if !slices.Contains(dissociatePaths, captionPath) {
			dissociatePaths = append(dissociatePaths, captionPath)
		}
	}
	for _, captionPath := range dissociatePaths {
		if err := video.DissociateCaption(ctx, captionPath, s.File, s.File); err != nil {
			return err
		}
	}

	return nil
}

// destroyFileEntries destroys file entries from the database without deleting
// the files from the filesystem
func (s *Service) destroyFileEntries(ctx context.Context, scene *models.Scene) error {
	if err := scene.LoadFiles(ctx, s.Repository); err != nil {
		return err
	}

	for _, f := range scene.Files.List() {
		// only destroy file entries where there is no other associated scene
		otherScenes, err := s.Repository.FindByFileID(ctx, f.ID)
		if err != nil {
			return err
		}

		if len(otherScenes) > 1 {
			// other scenes associated, don't remove
			continue
		}

		const deleteFile = false
		logger.Info("Destroying scene file entry: ", f.Path)
		if err := file.Destroy(ctx, s.File, f, nil, deleteFile); err != nil {
			return err
		}
	}

	return nil
}

// DestroyMarker deletes the scene marker from the database and returns a
// function that removes the generated files, to be executed after the
// transaction is successfully committed.
func DestroyMarker(ctx context.Context, scene *models.Scene, sceneMarker *models.SceneMarker, qb models.SceneMarkerDestroyer, fileDeleter *FileDeleter) error {
	if err := qb.Destroy(ctx, sceneMarker.ID); err != nil {
		return err
	}

	// delete the preview for the marker
	seconds := int(sceneMarker.Seconds)
	return fileDeleter.MarkMarkerFiles(scene, seconds)
}
