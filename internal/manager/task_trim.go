package manager

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/asticode/go-astisub"
	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/ffmpeg"
	"github.com/stashapp/stash/pkg/ffmpeg/transcoder"
	"github.com/stashapp/stash/pkg/fsutil"
	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/txn"
)

// TimeRange is a [Start, End) interval in seconds.
type TimeRange struct {
	Start float64
	End   float64
}

// trimSegmentCRF is the x264 quality used when re-encoding the kept segments.
// Near-visually-lossless; segments are re-encoded so cuts land on exact frames.
const trimSegmentCRF = "20"

// TrimVideoJob removes the DeleteRanges from a scene's video and joins the
// remaining parts into a new file, re-timing sidecar captions to match the new
// timeline. Modelled on RotateVideoJob.
//
// Intended for "delete unwanted segments before dubbing": run it on the source,
// then run subtitles/dubbing on the (clean) result so nothing needs re-aligning.
type TrimVideoJob struct {
	Scene        *models.Scene
	DeleteRanges []TimeRange
	// Replace overwrites the original file; otherwise a new <name>.trimmed.mp4 is written.
	Replace     bool
	TxnManager  models.TxnManager
	SceneFinder models.SceneReaderWriter
}

func (j *TrimVideoJob) Execute(ctx context.Context, progress *job.Progress) error {
	if len(j.DeleteRanges) == 0 {
		return fmt.Errorf("no delete ranges provided")
	}

	encoder := instance.FFMpeg
	if encoder == nil {
		return fmt.Errorf("ffmpeg not configured")
	}

	scene := j.Scene
	var inputPath string
	var duration float64
	var hasAudio bool

	if err := txn.WithReadTxn(ctx, j.TxnManager, func(ctx context.Context) error {
		if err := scene.LoadFiles(ctx, j.SceneFinder); err != nil {
			return fmt.Errorf("loading scene files: %w", err)
		}
		f := scene.Files.Primary()
		if f == nil {
			return fmt.Errorf("scene has no video file")
		}
		inputPath = f.Path
		duration = f.Duration
		hasAudio = f.AudioCodec != ""
		return nil
	}); err != nil {
		return err
	}

	if duration <= 0 {
		return fmt.Errorf("scene video has unknown duration; cannot trim")
	}

	keep, err := computeKeepIntervals(j.DeleteRanges, duration)
	if err != nil {
		return err
	}

	logger.Infof("Trimming video %s: removing %d range(s), keeping %d segment(s)", inputPath, len(j.DeleteRanges), len(keep))

	if err := instance.Paths.Generated.EnsureTmpDir(); err != nil {
		return fmt.Errorf("ensuring temp dir: %w", err)
	}
	tmpDir := instance.Paths.Generated.Tmp

	// 1. Smartcut: re-encode only the partial-GOP head/tail of each kept interval
	// (so cuts land on exact frames) and stream-copy the whole-GOP middle. A long
	// kept span then costs a couple of short re-encodes instead of re-encoding the
	// entire span — orders of magnitude faster, lossless on the copied part. If
	// keyframes can't be read, the interval is re-encoded whole (old behaviour).
	var ffprobePath string
	if instance.FFProbe != nil {
		ffprobePath = instance.FFProbe.Path()
	}
	keyframes, kerr := getVideoKeyframes(ctx, inputPath, ffprobePath)
	if kerr != nil {
		logger.Warnf("scene trim: reading keyframes (%v); falling back to full re-encode", kerr)
	}
	plan := planSmartcutSegments(keep, keyframes)
	logger.Infof("scene trim: %d kept segment(s) -> %d sub-segment(s), %d stream-copied", len(keep), len(plan), countCopies(plan))
	progress.SetTotal(len(plan) + 2)

	var segments []string
	defer func() {
		for _, s := range segments {
			_ = os.Remove(s)
		}
	}()

	for i, seg := range plan {
		if err := ctx.Err(); err != nil {
			return err
		}

		segPath := filepath.Join(tmpDir, fmt.Sprintf("trim_%d_%03d.mp4", scene.ID, i))

		opts := transcoder.TranscodeOptions{
			OutputPath:      segPath,
			StartTime:       seg.start,
			Duration:        seg.dur,
			ExtraOutputArgs: []string{"-avoid_negative_ts", "make_zero"},
		}
		if seg.copy {
			// whole-GOP middle: stream-copy, instant + lossless
			opts.VideoCodec = ffmpeg.VideoCodecCopy
			if hasAudio {
				opts.AudioCodec = ffmpeg.AudioCodecCopy
			}
		} else {
			// partial-GOP head/tail (short) or a no-copyable-GOP interval: re-encode
			opts.VideoCodec = ffmpeg.VideoCodecLibX264
			opts.VideoArgs = ffmpeg.Args{
				"-pix_fmt", "yuv420p",
				"-profile:v", "high",
				"-level", "4.2",
				"-preset", "medium",
				"-crf", trimSegmentCRF,
				"-threads", "4",
				"-strict", "-2",
			}
			if hasAudio {
				opts.AudioCodec = ffmpeg.AudioCodecAAC
				opts.AudioArgs = ffmpeg.Args{"-b:a", "192k"}
			}
		}

		args := transcoder.Transcode(inputPath, opts)
		if err := encoder.Generate(ctx, args); err != nil {
			return fmt.Errorf("cutting sub-segment %d [%.2f-%.2fs copy=%v]: %w", i, seg.start, seg.start+seg.dur, seg.copy, err)
		}
		segments = append(segments, segPath)
		progress.Increment()
	}

	// 2. concat the segments (paths relative to the list -> "safe" for ffmpeg)
	concatPath := filepath.Join(tmpDir, fmt.Sprintf("trim_%d_concat.txt", scene.ID))
	if err := writeConcatList(concatPath, segments); err != nil {
		return err
	}
	defer func() { _ = os.Remove(concatPath) }()

	ext := filepath.Ext(inputPath)
	outPath := strings.TrimSuffix(inputPath, ext) + ".trimmed.mp4"

	spliceArgs := transcoder.Splice(concatPath, transcoder.SpliceOptions{
		OutputPath: outPath,
		Format:     ffmpeg.FormatMP4,
		VideoArgs:  ffmpeg.Args{"-movflags", "+faststart"},
	})
	if err := encoder.Generate(ctx, spliceArgs); err != nil {
		_ = os.Remove(outPath)
		return fmt.Errorf("joining segments: %w", err)
	}
	progress.Increment()

	// 3. either replace the original (backup -> move) or keep the .trimmed.mp4
	finalPath := outPath
	if j.Replace {
		backupPath := inputPath + ".bak"
		if err := os.Rename(inputPath, backupPath); err != nil {
			_ = os.Remove(outPath)
			return fmt.Errorf("backing up original: %w", err)
		}
		if err := fsutil.SafeMove(outPath, inputPath); err != nil {
			_ = os.Rename(backupPath, inputPath) // restore
			return fmt.Errorf("replacing original with trimmed file: %w", err)
		}
		_ = os.Remove(backupPath)
		finalPath = inputPath
	}

	// 4. re-time sidecar captions onto the trimmed timeline (best-effort)
	retimeSidecarCaptions(inputPath, finalPath, j.DeleteRanges, duration)

	// 5. import/refresh the result so it is usable in stash
	if err := j.rescan(ctx, finalPath); err != nil {
		logger.Warnf("scene trim: failed to scan %s: %v", finalPath, err)
	}

	progress.Increment()
	logger.Infof("Successfully trimmed video -> %s", finalPath)
	return nil
}

func (j *TrimVideoJob) rescan(ctx context.Context, path string) error {
	mgr := GetInstance()
	if mgr == nil {
		return fmt.Errorf("manager instance not available")
	}
	_, err := mgr.Scan(ctx, ScanMetadataInput{
		Paths: []string{path},
		ScanMetadataOptions: config.ScanMetadataOptions{
			Rescan: true,
		},
	})
	return err
}

// computeKeepIntervals returns the complement of the (clamped, merged) delete
// ranges within [0, duration] — i.e. the parts of the video to keep.
func computeKeepIntervals(del []TimeRange, duration float64) ([]TimeRange, error) {
	merged := mergeDeleteRanges(del, duration)
	if len(merged) == 0 {
		return nil, fmt.Errorf("no valid delete ranges within the video duration")
	}

	const minKeep = 0.05 // drop sub-frame slivers
	var keep []TimeRange
	cursor := 0.0
	for _, r := range merged {
		if r.Start-cursor > minKeep {
			keep = append(keep, TimeRange{Start: cursor, End: r.Start})
		}
		cursor = r.End
	}
	if duration-cursor > minKeep {
		keep = append(keep, TimeRange{Start: cursor, End: duration})
	}

	if len(keep) == 0 {
		return nil, fmt.Errorf("delete ranges cover the entire video; nothing left to keep")
	}
	return keep, nil
}

// mergeDeleteRanges clamps ranges to [0, duration], drops empty ones, then sorts
// and merges overlapping/adjacent ranges.
func mergeDeleteRanges(del []TimeRange, duration float64) []TimeRange {
	var rs []TimeRange
	for _, r := range del {
		a, b := r.Start, r.End
		if a < 0 {
			a = 0
		}
		if duration > 0 && b > duration {
			b = duration
		}
		if b <= a {
			continue
		}
		rs = append(rs, TimeRange{Start: a, End: b})
	}
	sort.Slice(rs, func(i, k int) bool { return rs[i].Start < rs[k].Start })

	var merged []TimeRange
	for _, r := range rs {
		if n := len(merged); n > 0 && r.Start <= merged[n-1].End {
			if r.End > merged[n-1].End {
				merged[n-1].End = r.End
			}
		} else {
			merged = append(merged, r)
		}
	}
	return merged
}

// writeConcatList writes an ffmpeg concat-demuxer list. Paths are written
// relative to the list file's own directory so ffmpeg treats them as "safe"
// (no -safe 0 needed). Callers must keep the segments in that same directory.
func writeConcatList(listPath string, segments []string) error {
	f, err := os.Create(listPath)
	if err != nil {
		return fmt.Errorf("creating concat list: %w", err)
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, s := range segments {
		if _, err := fmt.Fprintf(w, "file '%s'\n", filepath.Base(s)); err != nil {
			return fmt.Errorf("writing concat list: %w", err)
		}
	}
	return w.Flush()
}

// retimeSidecarCaptions re-times the .srt/.vtt sidecars of srcVideo onto the
// trimmed timeline and writes them next to dstVideo. Best-effort.
func retimeSidecarCaptions(srcVideo, dstVideo string, del []TimeRange, duration float64) {
	srcBase := strings.TrimSuffix(srcVideo, filepath.Ext(srcVideo))
	dstBase := strings.TrimSuffix(dstVideo, filepath.Ext(dstVideo))
	merged := mergeDeleteRanges(del, duration)

	matches, err := filepath.Glob(srcBase + ".*")
	if err != nil {
		logger.Warnf("scene trim: globbing captions: %v", err)
		return
	}

	for _, m := range matches {
		switch strings.ToLower(filepath.Ext(m)) {
		case ".srt", ".vtt":
		default:
			continue
		}
		suffix := strings.TrimPrefix(m, srcBase) // e.g. ".en.srt"
		if strings.HasPrefix(suffix, ".trimmed.") {
			continue // skip our own prior outputs
		}
		dst := dstBase + suffix
		if dst == m {
			continue // nothing to do (shouldn't happen unless src==dst base)
		}
		if err := retimeCaptionFile(m, dst, merged); err != nil {
			logger.Warnf("scene trim: re-timing caption %s: %v", m, err)
			continue
		}
		logger.Infof("scene trim: re-timed caption -> %s", dst)
	}
}

// retimeCaptionFile drops cues that start inside a deleted range and shifts the
// rest earlier by the total removed time before them.
func retimeCaptionFile(src, dst string, merged []TimeRange) error {
	subs, err := astisub.OpenFile(src)
	if err != nil {
		return err
	}

	var kept []*astisub.Item
	for _, it := range subs.Items {
		startSec := it.StartAt.Seconds()
		if inAnyRange(startSec, merged) {
			continue // cue starts inside a removed region
		}
		shift := time.Duration(deletedBefore(startSec, merged) * float64(time.Second))
		it.StartAt -= shift
		it.EndAt -= shift
		if it.StartAt < 0 {
			it.StartAt = 0
		}
		if it.EndAt < it.StartAt {
			it.EndAt = it.StartAt
		}
		kept = append(kept, it)
	}
	subs.Items = kept

	return subs.Write(dst)
}

func inAnyRange(sec float64, ranges []TimeRange) bool {
	for _, r := range ranges {
		if sec >= r.Start && sec < r.End {
			return true
		}
	}
	return false
}

// deletedBefore returns the total removed duration lying entirely before sec.
func deletedBefore(sec float64, ranges []TimeRange) float64 {
	var total float64
	for _, r := range ranges {
		if r.End <= sec {
			total += r.End - r.Start
		}
	}
	return total
}

// trimSeg is one sub-segment of a kept interval: either stream-copied (the
// whole-GOP middle) or re-encoded (a partial-GOP head/tail, or a whole interval
// with no copyable GOP).
type trimSeg struct {
	start float64
	dur   float64
	copy  bool
}

func countCopies(segs []trimSeg) int {
	n := 0
	for _, s := range segs {
		if s.copy {
			n++
		}
	}
	return n
}

// getVideoKeyframes returns the sorted presentation timestamps (seconds) of the
// video stream's keyframes, read from packet flags (no decoding — fast even on
// long files). Returns an error if ffprobe is unavailable or fails.
func getVideoKeyframes(ctx context.Context, inputPath, ffprobePath string) ([]float64, error) {
	if ffprobePath == "" {
		return nil, fmt.Errorf("ffprobe path not available")
	}
	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "packet=pts_time,flags",
		"-of", "csv=p=0",
		inputPath)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe keyframes: %w", err)
	}

	var kf []float64
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// csv "<pts_time>,<flags>" — keyframes carry "K" in the flags field
		parts := strings.SplitN(line, ",", 2)
		if len(parts) < 2 || !strings.Contains(parts[1], "K") {
			continue
		}
		t, perr := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
		if perr != nil {
			continue
		}
		kf = append(kf, t)
	}
	sort.Float64s(kf)
	return kf, nil
}

// planSmartcutSegments splits each kept interval into copy/re-encode sub-segments.
// The partial-GOP head [start, firstKeyframe) and tail [lastKeyframe, end) are
// re-encoded so the cuts land on exact frames; the whole-GOP middle
// [firstKeyframe, lastKeyframe) is stream-copied. An interval with fewer than two
// usable interior keyframes (incl. the empty-keyframes fallback) is re-encoded whole.
func planSmartcutSegments(keep []TimeRange, kf []float64) []trimSeg {
	const eps = 0.05
	var segs []trimSeg
	for _, k := range keep {
		first, last := -1.0, -1.0
		for _, t := range kf {
			if t >= k.Start-eps && t <= k.End+eps {
				if first < 0 {
					first = t
				}
				last = t
			}
		}
		if first < 0 || last-first < eps {
			segs = append(segs, trimSeg{start: k.Start, dur: k.End - k.Start, copy: false})
			continue
		}
		if first-k.Start > eps {
			segs = append(segs, trimSeg{start: k.Start, dur: first - k.Start, copy: false})
		}
		segs = append(segs, trimSeg{start: first, dur: last - first, copy: true})
		if k.End-last > eps {
			segs = append(segs, trimSeg{start: last, dur: k.End - last, copy: false})
		}
	}
	return segs
}
