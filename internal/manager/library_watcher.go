package manager

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/fsutil"
	"github.com/stashapp/stash/pkg/logger"
)

// LibraryWatcher monitors library directories for file system changes
// and automatically triggers scan and cleanup tasks when changes are detected.
type LibraryWatcher struct {
	watcher      *fsnotify.Watcher
	manager      *Manager
	debounceTime time.Duration
	events       map[string]time.Time
	eventsMutex  sync.RWMutex
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// NewLibraryWatcher creates a new LibraryWatcher instance
func NewLibraryWatcher(manager *Manager) (*LibraryWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &LibraryWatcher{
		watcher:      watcher,
		manager:      manager,
		debounceTime: 2 * time.Second, // Debounce time to avoid excessive scanning
		events:       make(map[string]time.Time),
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
	for _, stashPath := range stashPaths {
		if err := lw.addPathRecursively(stashPath.Path); err != nil {
			logger.Warnf("Failed to add library path %s to watcher: %v", stashPath.Path, err)
			continue
		}
		logger.Infof("Monitoring library path: %s", stashPath.Path)
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

// addPathRecursively adds a directory and all its subdirectories to the watcher
func (lw *LibraryWatcher) addPathRecursively(path string) error {
	// Add the main path
	if err := lw.watcher.Add(path); err != nil {
		return err
	}

	// Recursively add subdirectories
	return filepath.Walk(path, func(dirPath string, info os.FileInfo, err error) error {
		if err != nil {
			logger.Warnf("Error walking directory %s: %v", dirPath, err)
			return nil // Continue walking
		}

		if info.IsDir() {
			if err := lw.watcher.Add(dirPath); err != nil {
				logger.Warnf("Failed to add subdirectory %s to watcher: %v", dirPath, err)
			}
		}

		return nil
	})
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
	// Get the directory containing the changed file
	dir := filepath.Dir(event.Name)

	lw.eventsMutex.Lock()
	lw.events[dir] = time.Now()
	lw.eventsMutex.Unlock()

	logger.Debugf("File system event detected: %s in %s", event.Op, dir)
}

// processAccumulatedEvents processes events that have accumulated during debounce time
func (lw *LibraryWatcher) processAccumulatedEvents() {
	lw.eventsMutex.Lock()
	defer lw.eventsMutex.Unlock()

	now := time.Now()
	var pathsToScan []string

	// Collect paths that need scanning
	for path, timestamp := range lw.events {
		if now.Sub(timestamp) >= lw.debounceTime {
			pathsToScan = append(pathsToScan, path)
			delete(lw.events, path)
		}
	}

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
		Paths: paths,
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
	lw.events = make(map[string]time.Time)
	lw.eventsMutex.Unlock()

	// Create new context
	ctx, cancel := context.WithCancel(context.Background())
	lw.ctx = ctx
	lw.cancel = cancel

	// Restart monitoring
	return lw.Start()
}
