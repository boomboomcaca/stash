package api

import (
	"context"
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/stashapp/stash/pkg/logger"
)

// PerformanceMetrics holds runtime performance metrics
type PerformanceMetrics struct {
	// HTTP metrics
	totalRequests     atomic.Uint64
	slowRequests      atomic.Uint64
	totalResponseTime atomic.Int64 // in microseconds
	maxResponseTime   atomic.Int64 // in microseconds
	minResponseTime   atomic.Int64 // in microseconds (initialized to max)

	// Runtime metrics
	startTime     time.Time
	lastMetricLog time.Time

	// Request tracking
	activeRequests     atomic.Int32
	requestsByEndpoint sync.Map // map[string]*EndpointMetrics
}

// EndpointMetrics tracks metrics for a specific endpoint
type EndpointMetrics struct {
	count     atomic.Uint64
	totalTime atomic.Int64
	maxTime   atomic.Int64
	slowCount atomic.Uint64
}

var globalMetrics = &PerformanceMetrics{
	startTime:     time.Now(),
	lastMetricLog: time.Now(),
}

func init() {
	// Initialize min response time to a very large value
	globalMetrics.minResponseTime.Store(1<<63 - 1)
}

// MetricsMiddleware is a middleware that collects performance metrics
func MetricsMiddleware() func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Track active requests
			globalMetrics.activeRequests.Add(1)
			defer globalMetrics.activeRequests.Add(-1)

			// Wrap response writer to capture status code
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			// Call the next handler
			next.ServeHTTP(ww, r)

			// Calculate response time
			duration := time.Since(start)
			durationMicros := duration.Microseconds()

			// Update global metrics
			globalMetrics.totalRequests.Add(1)
			globalMetrics.totalResponseTime.Add(durationMicros)

			// Update max response time
			for {
				oldMax := globalMetrics.maxResponseTime.Load()
				if durationMicros <= oldMax {
					break
				}
				if globalMetrics.maxResponseTime.CompareAndSwap(oldMax, durationMicros) {
					break
				}
			}

			// Update min response time
			for {
				oldMin := globalMetrics.minResponseTime.Load()
				if durationMicros >= oldMin {
					break
				}
				if globalMetrics.minResponseTime.CompareAndSwap(oldMin, durationMicros) {
					break
				}
			}

			// Track slow requests (> 1 second)
			if duration > time.Second {
				globalMetrics.slowRequests.Add(1)
				logger.Warnf("Slow request: %s %s took %v (status: %d)",
					r.Method, r.URL.Path, duration, ww.Status())
			}

			// Update endpoint-specific metrics
			endpoint := r.Method + " " + r.URL.Path
			value, _ := globalMetrics.requestsByEndpoint.LoadOrStore(endpoint, &EndpointMetrics{})
			endpointMetrics := value.(*EndpointMetrics)

			endpointMetrics.count.Add(1)
			endpointMetrics.totalTime.Add(durationMicros)

			// Update endpoint max time
			for {
				oldMax := endpointMetrics.maxTime.Load()
				if durationMicros <= oldMax {
					break
				}
				if endpointMetrics.maxTime.CompareAndSwap(oldMax, durationMicros) {
					break
				}
			}

			if duration > time.Second {
				endpointMetrics.slowCount.Add(1)
			}
		})
	}
}

// MemoryStats represents memory statistics
type MemoryStats struct {
	Alloc        uint64
	TotalAlloc   uint64
	Sys          uint64
	NumGC        uint32
	HeapAlloc    uint64
	HeapSys      uint64
	HeapIdle     uint64
	HeapInuse    uint64
	HeapReleased uint64
	HeapObjects  uint64
	StackInuse   uint64
	StackSys     uint64
}

// GetMemoryStats returns current memory statistics
func GetMemoryStats() MemoryStats {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	return MemoryStats{
		Alloc:        m.Alloc,
		TotalAlloc:   m.TotalAlloc,
		Sys:          m.Sys,
		NumGC:        m.NumGC,
		HeapAlloc:    m.HeapAlloc,
		HeapSys:      m.HeapSys,
		HeapIdle:     m.HeapIdle,
		HeapInuse:    m.HeapInuse,
		HeapReleased: m.HeapReleased,
		HeapObjects:  m.HeapObjects,
		StackInuse:   m.StackInuse,
		StackSys:     m.StackSys,
	}
}

// RuntimeMetrics represents runtime statistics
type RuntimeMetrics struct {
	Goroutines     int
	CGoCalls       int64
	MemStats       MemoryStats
	Uptime         time.Duration
	TotalRequests  uint64
	SlowRequests   uint64
	ActiveRequests int32
	AvgResponseMs  float64
	MaxResponseMs  float64
	MinResponseMs  float64
}

// GetRuntimeMetrics returns comprehensive runtime metrics
func GetRuntimeMetrics() RuntimeMetrics {
	totalReqs := globalMetrics.totalRequests.Load()
	totalTime := globalMetrics.totalResponseTime.Load()
	maxTime := globalMetrics.maxResponseTime.Load()
	minTime := globalMetrics.minResponseTime.Load()

	var avgResponseMs float64
	if totalReqs > 0 {
		avgResponseMs = float64(totalTime) / float64(totalReqs) / 1000.0
	}

	maxResponseMs := float64(maxTime) / 1000.0
	minResponseMs := float64(minTime) / 1000.0

	// If no requests yet, min will be the initial large value
	if totalReqs == 0 {
		minResponseMs = 0
	}

	return RuntimeMetrics{
		Goroutines:     runtime.NumGoroutine(),
		CGoCalls:       runtime.NumCgoCall(),
		MemStats:       GetMemoryStats(),
		Uptime:         time.Since(globalMetrics.startTime),
		TotalRequests:  totalReqs,
		SlowRequests:   globalMetrics.slowRequests.Load(),
		ActiveRequests: globalMetrics.activeRequests.Load(),
		AvgResponseMs:  avgResponseMs,
		MaxResponseMs:  maxResponseMs,
		MinResponseMs:  minResponseMs,
	}
}

// LogMetricsPeriodically logs metrics every interval
func LogMetricsPeriodically(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			metrics := GetRuntimeMetrics()
			mem := metrics.MemStats

			logger.Infof("Performance Metrics - Goroutines: %d, Memory: %.2f MB, "+
				"Requests: %d (%.0f/min), Slow: %d, Active: %d, "+
				"Avg Response: %.2f ms, Max: %.2f ms",
				metrics.Goroutines,
				float64(mem.Alloc)/(1024*1024),
				metrics.TotalRequests,
				calculateRequestRate(metrics.TotalRequests, metrics.Uptime),
				metrics.SlowRequests,
				metrics.ActiveRequests,
				metrics.AvgResponseMs,
				metrics.MaxResponseMs,
			)

			globalMetrics.lastMetricLog = time.Now()
		}
	}
}

// calculateRequestRate calculates requests per minute
func calculateRequestRate(totalRequests uint64, uptime time.Duration) float64 {
	if uptime.Seconds() == 0 {
		return 0
	}
	return float64(totalRequests) / uptime.Minutes()
}

// GetTopSlowEndpoints returns the top N slowest endpoints
func GetTopSlowEndpoints(n int) []EndpointStat {
	var stats []EndpointStat

	globalMetrics.requestsByEndpoint.Range(func(key, value interface{}) bool {
		endpoint := key.(string)
		metrics := value.(*EndpointMetrics)

		count := metrics.count.Load()
		if count == 0 {
			return true
		}

		totalTime := metrics.totalTime.Load()
		avgTime := float64(totalTime) / float64(count) / 1000.0 // convert to ms

		stats = append(stats, EndpointStat{
			Endpoint:  endpoint,
			Count:     count,
			AvgTimeMs: avgTime,
			MaxTimeMs: float64(metrics.maxTime.Load()) / 1000.0,
			SlowCount: metrics.slowCount.Load(),
		})

		return true
	})

	// Sort by average time (simple bubble sort for small datasets)
	for i := 0; i < len(stats); i++ {
		for j := i + 1; j < len(stats); j++ {
			if stats[j].AvgTimeMs > stats[i].AvgTimeMs {
				stats[i], stats[j] = stats[j], stats[i]
			}
		}
	}

	if len(stats) > n {
		stats = stats[:n]
	}

	return stats
}

// EndpointStat represents statistics for an endpoint
type EndpointStat struct {
	Endpoint  string
	Count     uint64
	AvgTimeMs float64
	MaxTimeMs float64
	SlowCount uint64
}

// ResetMetrics resets all collected metrics
func ResetMetrics() {
	globalMetrics.totalRequests.Store(0)
	globalMetrics.slowRequests.Store(0)
	globalMetrics.totalResponseTime.Store(0)
	globalMetrics.maxResponseTime.Store(0)
	globalMetrics.minResponseTime.Store(1<<63 - 1)
	globalMetrics.activeRequests.Store(0)
	globalMetrics.requestsByEndpoint = sync.Map{}
	globalMetrics.startTime = time.Now()
	globalMetrics.lastMetricLog = time.Now()
}
