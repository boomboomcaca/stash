package manager

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/internal/manager/task"
	"github.com/stashapp/stash/pkg/file/video"
	"github.com/stashapp/stash/pkg/fsutil"
	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
)

// pendingChange tracks the timing of accumulated file-system events for a
// single directory. lastEvent is pushed forward on every new event (and while
// stash is busy) so the debounce window measures quiet time; firstSeen records
// when the directory first became dirty and is never moved, so a directory that
// keeps being deferred because stash is busy is still acted on once maxDefer
// has elapsed since it first changed.
type pendingChange struct {
	firstSeen time.Time
	lastEvent time.Time
}

// LibraryWatcher monitors library directories for file system changes
// and automatically triggers scan and cleanup tasks when changes are detected.
type LibraryWatcher struct {
	watcher      *fsnotify.Watcher
	manager      *Manager
	debounceTime time.Duration
	// maxDefer bounds how long a dirty directory may be deferred while stash is
	// busy. Without it, the watcher's own scan/clean/generate cascade keeps the
	// job queue non-empty, which reset every pending directory's timer each tick
	// and starved genuine external changes indefinitely. Once a directory has
	// been dirty for maxDefer it is scanned on the next idle cycle regardless of
	// how recently its lastEvent was pushed.
	maxDefer    time.Duration
	events      map[string]*pendingChange
	eventsMutex sync.RWMutex
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// NewLibraryWatcher creates a new LibraryWatcher instance
func NewLibraryWatcher(manager *Manager) (*LibraryWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &LibraryWatcher{
		watcher: watcher,
		manager: manager,

		debounceTime: 30 * time.Second, // Increased debounce time for network mounts
		maxDefer:     5 * time.Minute,  // Upper bound on busy-deferral so real changes aren't starved
		events:       make(map[string]*pendingChange),
		ctx:          ctx,
		cancel:       cancel,
	}, nil
}

// Start begins monitoring the configured library paths
func (lw *LibraryWatcher) Start() error {
	stashPaths := lw.manager.Config.GetStashPaths()

	if len(stashPaths) == 0 {
		logger.Info("No library paths configured, skipping file system monitoring")
		return nil
	}

	// Add all library paths to the watcher
	totalFailed := 0
	for _, stashPath := range stashPaths {
		failed, err := lw.addPathRecursively(stashPath.Path)
		totalFailed += failed
		if err != nil {
			logger.Warnf("Failed to add library path %s to watcher: %v", stashPath.Path, err)
			continue
		}
		logger.Infof("Monitoring library path: %s", stashPath.Path)
	}

	// Surface silent watch failures as a single summary. On Linux these usually
	// mean the inotify watch limit (fs.inotify.max_user_watches) was exhausted,
	// which leaves whole subtrees silently unwatched — the most common reason
	// "new files aren't triggering a scan" for large libraries.
	if totalFailed > 0 {
		logger.Errorf("Library watcher: %d directories could not be watched; changes in them will NOT trigger auto-scan. On Linux this is usually the inotify watch limit (fs.inotify.max_user_watches) — consider increasing it.", totalFailed)
	}

	// Start the event processing goroutine
	lw.wg.Add(1)
	go lw.processEvents()

	// Start the debounce processing goroutine
	lw.wg.Add(1)
	go lw.processDebouncedEvents()

	logger.Info("Library file system monitoring started")
	return nil
}

// Stop stops the library watcher
func (lw *LibraryWatcher) Stop() error {
	lw.cancel()

	if err := lw.watcher.Close(); err != nil {
		logger.Warnf("Error closing file system watcher: %v", err)
	}

	lw.wg.Wait()
	logger.Info("Library file system monitoring stopped")
	return nil
}

// addPathRecursively adds a directory and all its subdirectories to the watcher.
// It returns the number of directories that could not be watched (e.g. because
// the inotify watch limit was exhausted); the caller can surface a summary so
// these silent failures are visible.
func (lw *LibraryWatcher) addPathRecursively(path string) (int, error) {
	// Add the main path
	if err := lw.watcher.Add(path); err != nil {
		return 1, err
	}

	failed := 0

	// Recursively add subdirectories
	err := filepath.Walk(path, func(dirPath string, info os.FileInfo, err error) error {
		if err != nil {
			logger.Warnf("Error walking directory %s: %v", dirPath, err)
			return nil // Continue walking
		}

		if info.IsDir() {
			if err := lw.watcher.Add(dirPath); err != nil {
				failed++
				logger.Warnf("Failed to add subdirectory %s to watcher: %v", dirPath, err)
			}
		}

		return nil
	})

	return failed, err
}

// processEvents handles file system events from the watcher
func (lw *LibraryWatcher) processEvents() {
	defer lw.wg.Done()

	for {
		select {
		case event, ok := <-lw.watcher.Events:
			if !ok {
				return
			}

			// Only process events for files we care about
			if lw.shouldProcessEvent(event) {
				lw.handleEvent(event)
			}

		case err, ok := <-lw.watcher.Errors:
			if !ok {
				return
			}
			logger.Warnf("File system watcher error: %v", err)

		case <-lw.ctx.Done():
			return
		}
	}
}

// processDebouncedEvents processes accumulated events after debounce time
func (lw *LibraryWatcher) processDebouncedEvents() {
	defer lw.wg.Done()

	ticker := time.NewTicker(lw.debounceTime)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			lw.processAccumulatedEvents()

		case <-lw.ctx.Done():
			return
		}
	}
}

// shouldProcessEvent determines if an event should be processed
func (lw *LibraryWatcher) shouldProcessEvent(event fsnotify.Event) bool {
	// Only process write, create, remove, and rename events
	if event.Op&fsnotify.Write == 0 &&
		event.Op&fsnotify.Create == 0 &&
		event.Op&fsnotify.Remove == 0 &&
		event.Op&fsnotify.Rename == 0 {
		return false
	}

	// Ignore subtitle files; they are not media files and should not trigger scans.
	if fsutil.MatchExtension(event.Name, video.SubtitleExts) {
		return false
	}

	// Ignore dub-script sidecars ("<name>.<lang>.srt.dub"): they end in ".dub"
	// (not a subtitle extension) but are dub-routing metadata, not media, so they
	// must not trigger scan/clean/generate cycles when the dub task writes them.
	if filepath.Ext(event.Name) == ".dub" {
		return false
	}

	// Ignore recap sidecars: "<name>.recapscript.json" (the cached LLM narration
	// plan, for audit/regeneration) and "<name>.recapskip" (a marker left when a
	// recap run produced nothing usable, so rescans don't retry forever). Neither
	// is media.
	if ext := filepath.Ext(event.Name); ext == ".recapskip" ||
		strings.HasSuffix(event.Name, ".recapscript.json") {
		return false
	}

	// Check if the path is within a configured library path
	stashPaths := lw.manager.Config.GetStashPaths()
	for _, stashPath := range stashPaths {
		if fsutil.IsPathInDir(stashPath.Path, event.Name) {
			return true
		}
	}

	return false
}

// handleEvent processes a file system event
func (lw *LibraryWatcher) handleEvent(event fsnotify.Event) {
	// If a new directory is created, add it to the watcher recursively
	if event.Op&fsnotify.Create != 0 {
		info, err := os.Stat(event.Name)
		if err == nil && info.IsDir() {
			logger.Infof("New directory detected, adding to watcher: %s", event.Name)
			if _, err := lw.addPathRecursively(event.Name); err != nil {
				logger.Warnf("Failed to add new directory %s to watcher: %v", event.Name, err)
			}

			// Close the inotify race: when a whole directory tree is dropped in
			// at once (e.g. copying a folder into the library), the files inside
			// it may already exist by the time the watch is installed above, so
			// their Create events never arrive. Re-record the new directory as
			// dirty here so its current contents are picked up on the next
			// debounce cycle regardless of whether per-file events were seen.
			lw.recordDirty(event.Name)
		}
	}

	// Get the directory containing the changed file
	dir := filepath.Dir(event.Name)
	// If the event itself is a directory, use the directory itself
	info, err := os.Stat(event.Name)
	if err == nil && info.IsDir() {
		dir = event.Name
	}

	lw.recordDirty(dir)

	logger.Debugf("File system event detected: %s in %s", event.Op, dir)
}

// recordDirty marks a directory as changed, starting its debounce timer if it
// is not already pending. firstSeen is only set the first time the directory
// becomes dirty so the maxDefer bound measures from the original change.
func (lw *LibraryWatcher) recordDirty(dir string) {
	now := time.Now()
	lw.eventsMutex.Lock()
	if pc, ok := lw.events[dir]; ok {
		pc.lastEvent = now
	} else {
		lw.events[dir] = &pendingChange{firstSeen: now, lastEvent: now}
	}
	lw.eventsMutex.Unlock()
}

// busy reports whether stash currently has any queued or running job. The
// watcher only acts when stash is idle, so that file changes stash itself
// makes during its own tasks do not retrigger it.
func (lw *LibraryWatcher) busy() bool {
	for _, j := range lw.manager.JobManager.GetQueue() {
		switch j.Status {
		case job.StatusReady, job.StatusRunning, job.StatusStopping:
			return true
		}
	}
	return false
}

// processAccumulatedEvents processes events that have accumulated during debounce time
func (lw *LibraryWatcher) processAccumulatedEvents() {
	// If stash is already busy with its own tasks, skip this cycle and drop the
	// accumulated events. File-system events seen while a scan/generate/clean job
	// is running are almost always SELF-INDUCED — e.g. the SceneRename plugin
	// (Scene.Update.Post hook) renaming media files during a scan, or generate
	// writing derived "<name>.<lang>-dub.mp4"/recap sidecars into a library path.
	// Reacting would queue another scan whose updates rename more files, which the
	// watcher sees again: an endless scan→rename→scan loop that floods the task
	// queue. The running task already covers any genuine change, so wait until
	// stash is idle before triggering anything.
	now := time.Now()

	if lw.busy() {
		// Defer rather than discard. The running task (or the watcher's own
		// scan→clean→generate cascade) may make file changes we would otherwise
		// react to — e.g. the SceneRename plugin renaming media during a scan —
		// which is why we don't trigger while busy. But clearing the map here
		// also threw away genuine external changes (a file dropped into a library
		// folder while a long job runs), which then stayed invisible until the
		// next unrelated event. Instead, keep the accumulated events and push
		// their debounce deadline forward so they are only acted on once stash
		// has been idle for a full debounce window: self-induced churn stops when
		// the task ends, while real changes survive to be scanned.
		//
		// Pushing lastEvent forward on every busy tick could, on its own, defer a
		// directory forever if stash is never idle for a full debounce window
		// (the watcher's own cascade keeps the queue busy). So we only defer
		// directories that first became dirty less than maxDefer ago; any that
		// have been waiting longer are forced through below even while busy, so
		// genuine external changes can't be starved indefinitely.
		lw.eventsMutex.Lock()
		var forced []string
		for path, pc := range lw.events {
			if now.Sub(pc.firstSeen) >= lw.maxDefer {
				forced = append(forced, path)
				delete(lw.events, path)
			} else {
				pc.lastEvent = now
			}
		}
		lw.eventsMutex.Unlock()

		if len(forced) == 0 {
			logger.Debug("Library watcher: stash busy, deferring auto-scan until idle")
			return
		}

		logger.Infof("Library watcher: %d path(s) deferred beyond max wait; scanning despite busy queue", len(forced))
		lw.triggerScanAndCleanup(forced)
		return
	}

	lw.eventsMutex.Lock()
	var pathsToScan []string

	// Collect paths that need scanning: either quiet for a full debounce window,
	// or dirty for longer than maxDefer regardless of recent activity.
	for path, pc := range lw.events {
		if now.Sub(pc.lastEvent) >= lw.debounceTime || now.Sub(pc.firstSeen) >= lw.maxDefer {
			pathsToScan = append(pathsToScan, path)
			delete(lw.events, path)
		}
	}
	lw.eventsMutex.Unlock()

	if len(pathsToScan) == 0 {
		return
	}

	logger.Infof("Processing %d library path changes", len(pathsToScan))

	// Trigger scan and cleanup tasks
	lw.triggerScanAndCleanup(pathsToScan)
}

// triggerScanAndCleanup triggers scan and cleanup tasks for the given paths
func (lw *LibraryWatcher) triggerScanAndCleanup(paths []string) {
	ctx := context.Background()

	// Get default scan settings and use them for automatic scanning
	defaultScanSettings := lw.manager.Config.GetDefaultScanSettings()
	scanOptions := config.ScanMetadataOptions{
		Rescan: false, // Don't rescan existing files
	}

	// Apply default scan settings if they exist
	if defaultScanSettings != nil {
		scanOptions.ScanGenerateCovers = defaultScanSettings.ScanGenerateCovers
		scanOptions.ScanGeneratePreviews = defaultScanSettings.ScanGeneratePreviews
		scanOptions.ScanGenerateImagePreviews = defaultScanSettings.ScanGenerateImagePreviews
		scanOptions.ScanGenerateSprites = defaultScanSettings.ScanGenerateSprites
		scanOptions.ScanGeneratePhashes = defaultScanSettings.ScanGeneratePhashes
		scanOptions.ScanGenerateThumbnails = defaultScanSettings.ScanGenerateThumbnails
		scanOptions.ScanGenerateClipPreviews = defaultScanSettings.ScanGenerateClipPreviews
	}

	// Trigger scan task
	scanInput := ScanMetadataInput{
		Paths:               paths,
		ScanMetadataOptions: scanOptions,
	}

	if _, err := lw.manager.Scan(ctx, scanInput); err != nil {
		logger.Errorf("Failed to trigger scan task: %v", err)
	} else {
		logger.Infof("Triggered scan task for %d paths", len(paths))
	}

	// Trigger cleanup task
	cleanupInput := CleanMetadataInput{
		Paths:  paths,
		DryRun: false, // Actually perform cleanup
	}

	if jobID := lw.manager.Clean(ctx, cleanupInput); jobID > 0 {
		logger.Infof("Triggered cleanup task (job ID: %d) for %d paths", jobID, len(paths))
	} else {
		logger.Warnf("Failed to trigger cleanup task")
	}

	// Trigger clean generated files task
	cleanGeneratedOptions := task.CleanGeneratedOptions{
		BlobFiles:       true,
		Sprites:         true,
		Screenshots:     true,
		Transcodes:      true,
		Markers:         true,
		ImageThumbnails: true,
		DryRun:          false, // Actually perform cleanup
	}

	cleanGeneratedJob := &task.CleanGeneratedJob{
		Options:                  cleanGeneratedOptions,
		Paths:                    lw.manager.Paths,
		BlobsStorageType:         lw.manager.Config.GetBlobsStorage(),
		VideoFileNamingAlgorithm: lw.manager.Config.GetVideoFileNamingAlgorithm(),
		Repository:               lw.manager.Repository,
		BlobCleaner:              lw.manager.Repository.Blob,
	}

	if jobID := lw.manager.JobManager.Add(ctx, "Cleaning generated files...", cleanGeneratedJob); jobID > 0 {
		logger.Infof("Triggered clean generated files task (job ID: %d)", jobID)
	} else {
		logger.Warnf("Failed to trigger clean generated files task")
	}

	// Trigger optimize database task
	if jobID := lw.manager.OptimiseDatabase(ctx); jobID > 0 {
		logger.Infof("Triggered optimize database task (job ID: %d)", jobID)
	} else {
		logger.Warnf("Failed to trigger optimize database task")
	}

	// Get user-configured generation settings
	generateSettings := lw.manager.Config.GetDefaultGenerateSettings()

	// Use user settings if available, otherwise use comprehensive defaults
	var generateInput GenerateMetadataInput
	if generateSettings != nil {
		// Convert user settings to GenerateMetadataInput
		generateInput = GenerateMetadataInput{
			Covers:              generateSettings.Covers,
			Sprites:             generateSettings.Sprites,
			Previews:            generateSettings.Previews,
			ImagePreviews:       generateSettings.ImagePreviews,
			Markers:             generateSettings.Markers,
			MarkerImagePreviews: generateSettings.MarkerImagePreviews,
			MarkerScreenshots:   generateSettings.MarkerScreenshots,
			Phashes:             generateSettings.Phashes,
			ClipPreviews:        generateSettings.ClipPreviews,
			ImageThumbnails:     generateSettings.ImageThumbnails,
			Overwrite:           false, // Don't overwrite existing files
		}

		// Apply preview options if configured
		if generateSettings.PreviewOptions != nil {
			generateInput.PreviewOptions = &GeneratePreviewOptionsInput{
				PreviewSegments:        generateSettings.PreviewOptions.PreviewSegments,
				PreviewSegmentDuration: generateSettings.PreviewOptions.PreviewSegmentDuration,
				PreviewExcludeStart:    generateSettings.PreviewOptions.PreviewExcludeStart,
				PreviewExcludeEnd:      generateSettings.PreviewOptions.PreviewExcludeEnd,
				PreviewPreset:          generateSettings.PreviewOptions.PreviewPreset,
			}
		}

		logger.Infof("Using user-configured generation settings: covers=%v, sprites=%v, previews=%v, imagePreviews=%v, markers=%v, markerImagePreviews=%v, markerScreenshots=%v, phashes=%v, clipPreviews=%v, imageThumbnails=%v",
			generateSettings.Covers, generateSettings.Sprites, generateSettings.Previews, generateSettings.ImagePreviews,
			generateSettings.Markers, generateSettings.MarkerImagePreviews, generateSettings.MarkerScreenshots,
			generateSettings.Phashes, generateSettings.ClipPreviews, generateSettings.ImageThumbnails)
	} else {
		// Fallback to comprehensive defaults if no user settings
		generateInput = GenerateMetadataInput{
			Covers:              true,  // Generate scene covers
			Sprites:             true,  // Generate scrubber sprites
			Previews:            true,  // Generate video previews
			ImagePreviews:       true,  // Generate animated image previews
			Markers:             true,  // Generate marker previews
			MarkerImagePreviews: true,  // Generate marker animated image previews
			MarkerScreenshots:   true,  // Generate marker screenshots
			Phashes:             true,  // Generate perceptual hashes
			ClipPreviews:        true,  // Generate previews for image clips
			ImageThumbnails:     true,  // Generate thumbnails for images
			Overwrite:           false, // Don't overwrite existing files
		}
		logger.Infof("Using comprehensive default generation settings (no user settings found)")
	}

	if jobID, err := lw.manager.Generate(ctx, generateInput); err != nil {
		logger.Errorf("Failed to trigger generation task: %v", err)
	} else if jobID > 0 {
		logger.Infof("Triggered comprehensive generation task (job ID: %d)", jobID)
	} else {
		logger.Warnf("Failed to trigger generation task")
	}
}

// RefreshPaths refreshes the watched paths when configuration changes
func (lw *LibraryWatcher) RefreshPaths() error {
	// Stop current monitoring
	lw.cancel()
	lw.wg.Wait()

	// Close current watcher
	if err := lw.watcher.Close(); err != nil {
		logger.Warnf("Error closing file system watcher during refresh: %v", err)
	}

	// Create new watcher
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	lw.watcher = watcher
	lw.eventsMutex.Lock()
	lw.events = make(map[string]*pendingChange)
	lw.eventsMutex.Unlock()

	// Create new context
	ctx, cancel := context.WithCancel(context.Background())
	lw.ctx = ctx
	lw.cancel = cancel

	// Restart monitoring
	return lw.Start()
}
