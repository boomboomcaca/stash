package utils

import (
	"math"
	"runtime"
	"strconv"

	"github.com/corona10/goimagehash"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/sliceutil"
)

type Phash struct {
	SceneID   int     `db:"id"`
	Hash      int64   `db:"phash"`
	Duration  float64 `db:"duration"`
	Neighbors []int
	Bucket    int
}

func FindDuplicates(hashes []*Phash, distance int, durationDiff float64) [][]int {
	// Limit the number of hashes to prevent memory overflow
	const maxHashes = 10000
	if len(hashes) > maxHashes {
		logger.Warnf("Too many hashes (%d), limiting to %d to prevent memory overflow", len(hashes), maxHashes)
		hashes = hashes[:maxHashes]
	}

	// Pre-allocate slices with known capacity
	neighbors := make([][]int, len(hashes))
	for i := range neighbors {
		neighbors[i] = make([]int, 0, 10) // Pre-allocate with reasonable capacity
	}

	for i, scene := range hashes {
		sceneHash := goimagehash.NewImageHash(uint64(scene.Hash), goimagehash.PHash)

		// Use batch processing to reduce memory pressure
		batchSize := 100
		for start := 0; start < len(hashes); start += batchSize {
			end := start + batchSize
			if end > len(hashes) {
				end = len(hashes)
			}

			for j := start; j < end; j++ {
				if i != j && scene.SceneID != hashes[j].SceneID {
					neighbourDurationDistance := 0.
					if scene.Duration > 0 && hashes[j].Duration > 0 {
						neighbourDurationDistance = math.Abs(scene.Duration - hashes[j].Duration)
					}
					if (neighbourDurationDistance <= durationDiff) || (durationDiff < 0) {
						neighborHash := goimagehash.NewImageHash(uint64(hashes[j].Hash), goimagehash.PHash)
						neighborDistance, _ := sceneHash.Distance(neighborHash)
						if neighborDistance <= distance {
							neighbors[i] = append(neighbors[i], j)
						}
					}
				}
			}

			// Force garbage collection every batch to free memory
			if start%1000 == 0 {
				runtime.GC()
			}
		}

		scene.Neighbors = neighbors[i]
	}

	var buckets [][]int
	for _, scene := range hashes {
		if len(scene.Neighbors) > 0 && scene.Bucket == -1 {
			bucket := len(buckets)
			scenes := make([]int, 0, 10) // Pre-allocate with reasonable capacity
			scenes = append(scenes, scene.SceneID)
			scene.Bucket = bucket
			findNeighbors(bucket, scene.Neighbors, hashes, &scenes)

			if len(scenes) > 1 {
				buckets = append(buckets, scenes)
			}
		}
	}

	return buckets
}

func findNeighbors(bucket int, neighbors []int, hashes []*Phash, scenes *[]int) {
	for _, id := range neighbors {
		hash := hashes[id]
		if hash.Bucket == -1 {
			hash.Bucket = bucket
			*scenes = sliceutil.AppendUnique(*scenes, hash.SceneID)
			findNeighbors(bucket, hash.Neighbors, hashes, scenes)
		}
	}
}

func PhashToString(phash int64) string {
	return strconv.FormatUint(uint64(phash), 16)
}

func StringToPhash(s string) (int64, error) {
	ret, err := strconv.ParseUint(s, 16, 64)
	if err != nil {
		return 0, err
	}

	return int64(ret), nil
}
