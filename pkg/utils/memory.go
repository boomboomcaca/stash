package utils

import (
	"runtime"
	"runtime/debug"
	"sync"
	"time"
	"unsafe"

	"github.com/stashapp/stash/pkg/logger"
)

// MemoryManager provides utilities for memory management and monitoring
type MemoryManager struct {
	maxMemoryMB   int64
	checkInterval time.Duration
	stopChan      chan struct{}
	mu            sync.RWMutex
	lastGC        time.Time
	gcThreshold   time.Duration
}

// NewMemoryManager creates a new memory manager with the specified limits
func NewMemoryManager(maxMemoryMB int64) *MemoryManager {
	return &MemoryManager{
		maxMemoryMB:   maxMemoryMB,
		checkInterval: 30 * time.Second,
		gcThreshold:   5 * time.Minute,
		stopChan:      make(chan struct{}),
	}
}

// Start begins memory monitoring
func (mm *MemoryManager) Start() {
	go mm.monitor()
}

// Stop stops memory monitoring
func (mm *MemoryManager) Stop() {
	close(mm.stopChan)
}

// monitor continuously monitors memory usage
func (mm *MemoryManager) monitor() {
	ticker := time.NewTicker(mm.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			mm.checkMemoryUsage()
		case <-mm.stopChan:
			return
		}
	}
}

// checkMemoryUsage checks current memory usage and triggers GC if needed
func (mm *MemoryManager) checkMemoryUsage() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	currentMB := int64(m.Alloc / 1024 / 1024)
	maxMB := mm.maxMemoryMB

	if currentMB > maxMB {
		logger.Warnf("Memory usage (%d MB) exceeds limit (%d MB), forcing garbage collection", currentMB, maxMB)
		runtime.GC()
		runtime.ReadMemStats(&m)
		afterMB := int64(m.Alloc / 1024 / 1024)
		logger.Infof("After GC: %d MB", afterMB)
	}

	// Periodic GC to prevent memory fragmentation
	mm.mu.Lock()
	now := time.Now()
	if now.Sub(mm.lastGC) > mm.gcThreshold {
		runtime.GC()
		mm.lastGC = now
		logger.Debugf("Periodic garbage collection performed")
	}
	mm.mu.Unlock()
}

// ForceGC forces garbage collection
func (mm *MemoryManager) ForceGC() {
	runtime.GC()
	mm.mu.Lock()
	mm.lastGC = time.Now()
	mm.mu.Unlock()
}

// GetMemoryStats returns current memory statistics
func (mm *MemoryManager) GetMemoryStats() runtime.MemStats {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m
}

// SetMemoryLimit sets the maximum memory limit in MB
func (mm *MemoryManager) SetMemoryLimit(mb int64) {
	mm.mu.Lock()
	mm.maxMemoryMB = mb
	mm.mu.Unlock()
}

// LimitMemoryUsage limits memory usage by forcing GC and setting debug settings
func LimitMemoryUsage() {
	// Set GC target percentage to be more aggressive
	debug.SetGCPercent(50)

	// Force immediate garbage collection
	runtime.GC()

	logger.Debugf("Memory usage limited - GC target set to 50%%")
}

// SafeAppend safely appends to a slice with memory checks
func SafeAppend[T any](slice []T, items ...T) []T {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	// If memory usage is high, force GC before appending
	if m.Alloc > 100*1024*1024 { // 100MB threshold
		runtime.GC()
	}

	return append(slice, items...)
}

// SafeMakeSlice creates a slice with memory safety checks
func SafeMakeSlice[T any](length, capacity int) []T {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	// Estimate memory needed (rough calculation)
	estimatedBytes := capacity * int(unsafe.Sizeof(*new(T)))

	// If estimated memory is too high, reduce capacity
	if estimatedBytes > 50*1024*1024 { // 50MB threshold
		logger.Warnf("Large slice allocation detected (%d bytes), reducing capacity", estimatedBytes)
		capacity = 50 * 1024 * 1024 / int(unsafe.Sizeof(*new(T)))
		if capacity < length {
			capacity = length
		}
	}

	return make([]T, length, capacity)
}
