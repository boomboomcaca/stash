package manager

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/ffmpeg"
	"github.com/stashapp/stash/pkg/ffmpeg/transcoder"
	"github.com/stashapp/stash/pkg/file/video"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
)

const recapPath = "/v1/recap"

// GenerateRecapTask produces a narrated plot-recap (解说) derivative video for a
// scene: it transcribes/understands the source, asks an LLM (via the configured
// recap service) for a condensed narration script keyed to source cues, picks
// the matching clips, dubs the narration, and cuts+concatenates+muxes them into
// a sidecar "<name>.<lang>-recap.mp4" capped at a target length. The original
// video is left untouched.
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

// recapVoiceName resolves the narrator voice: an explicit per-run Voice wins,
// otherwise the configured recap voice (distinct from the dialogue dub voice).
func (t *GenerateRecapTask) recapVoiceName() string {
	if t.Voice != "" {
		return t.Voice
	}
	return config.GetInstance().GetRecapVoice()
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

	if err := recapScene(ctx, t.repository, t.Scene, f.Path, f.Duration,
		t.recapTargetLang(), t.recapVoiceName(), t.Overwrite); err != nil {
		logger.Errorf("[recap] %v", err)
	}
}

// recapScene runs the whole recap pipeline for one video: source transcript ->
// LLM narration script -> clip plan -> per-clip extract + dubbed narration ->
// concat + mux into "<name>.<lang>-recap.mp4". The original video is untouched.
// A missing transcript / empty script is treated as a skip (nil error) and
// leaves a ".recapskip" marker so rescans don't retry forever.
func recapScene(ctx context.Context, repo models.Repository, scene models.Scene, videoPath string, duration float64, lang, voice string, overwrite bool) error {
	cfg := config.GetInstance()
	outPath := recapOutputPath(videoPath, lang)
	skipPath := videoPath + ".recapskip"

	if !overwrite {
		if _, err := os.Stat(outPath); err == nil {
			return nil
		}
		if _, err := os.Stat(skipPath); err == nil {
			return nil
		}
	}

	maxMinutes := cfg.GetRecapMaxMinutes()
	maxDur := float64(maxMinutes) * 60

	// 1. source transcript (existing caption preferred, else transcribe on demand)
	cues, transcript, err := loadRecapTranscript(ctx, repo, scene, videoPath)
	if err != nil {
		return fmt.Errorf("recap transcript for %s: %w", videoPath, err)
	}
	if len(cues) == 0 {
		logger.Warnf("[recap] no transcript for %s; skipping", videoPath)
		writeRecapSkip(skipPath)
		return nil
	}

	// 2. condensed narration script from the LLM recap service
	beats, err := requestRecapScript(ctx, transcript, lang, maxMinutes)
	if err != nil {
		return fmt.Errorf("recap script service for %s: %w", videoPath, err)
	}
	if data, derr := json.MarshalIndent(beats, "", "  "); derr == nil {
		_ = os.WriteFile(recapScriptPath(videoPath), data, 0644)
	}

	// 2.5 optional: hand the entire render to the upgraded external renderer
	// (render_recap.py — original-audio bed, one-line subtitles, cold-open,
	// loudness-normalization, truncation-safe dubbing). Opt-in via
	// RECAP_RENDER_SCRIPT=/path/to/render_recap.py; when unset, the built-in Go
	// clip+dub+mux below runs unchanged, so default behaviour is preserved.
	if script := strings.TrimSpace(os.Getenv("RECAP_RENDER_SCRIPT")); script != "" {
		if err := renderRecapViaScript(ctx, script, beats, cues, videoPath, outPath, voice); err != nil {
			return fmt.Errorf("recap render script for %s: %w", videoPath, err)
		}
		logger.Infof("[recap] generated %s via %s", outPath, script)
		return nil
	}

	// 3. turn cue references into a bounded, ordered clip plan
	clips := planRecapClips(beats, cues, duration, maxDur)
	if len(clips) == 0 {
		logger.Warnf("[recap] script yielded no usable clips for %s; skipping", videoPath)
		writeRecapSkip(skipPath)
		return nil
	}

	work, err := os.MkdirTemp("", "stash-recap-")
	if err != nil {
		return fmt.Errorf("creating recap workdir: %w", err)
	}
	defer os.RemoveAll(work)

	// 4. per-clip: extract a uniform re-encoded clip, then synthesize its
	// narration fit to the clip's actual length so video and audio stay in sync.
	var clipParts, wavParts []string
	var display strings.Builder
	offset := 0.0
	for i, c := range clips {
		clipPath := filepath.Join(work, fmt.Sprintf("c%d.mp4", i))
		if err := extractRecapClip(ctx, videoPath, c.start, c.end-c.start, clipPath); err != nil {
			return fmt.Errorf("recap clip %d [%.1f-%.1fs] for %s: %w", i, c.start, c.end, videoPath, err)
		}
		realDur, derr := probeRecapDuration(clipPath)
		if derr != nil || realDur <= 0 {
			realDur = c.end - c.start
		}
		narrSRT := singleCueSRT(c.text, realDur)
		wavPath := filepath.Join(work, fmt.Sprintf("n%d.wav", i))
		// The dub service is reached over the LAN and that hop can flap mid-run
		// (a single reset would otherwise discard the whole multi-minute job), so
		// retry transient failures with a short backoff before giving up. (derr is
		// already declared above by probeRecapDuration; reuse it here.)
		for attempt := 1; attempt <= 4; attempt++ {
			if _, _, derr = requestDub(ctx, narrSRT, realDur, voice, "", wavPath); derr == nil {
				break
			}
			logger.Warnf("[recap] narration %d attempt %d/4 failed: %v", i, attempt, derr)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			}
		}
		if derr != nil {
			return fmt.Errorf("recap narration %d for %s: %w", i, videoPath, derr)
		}
		clipParts = append(clipParts, clipPath)
		wavParts = append(wavParts, wavPath)
		fmt.Fprintf(&display, "%d\n%s --> %s\n%s\n\n", i+1,
			secsToTimecode(offset), secsToTimecode(offset+realDur), strings.TrimSpace(c.text))
		offset += realDur
		logger.Infof("[recap] clip %d/%d [%.0f-%.0fs src] -> %.1fs narration", i+1, len(clips), c.start, c.end, realDur)
	}

	// 5. concat clips + narration, then mux into the sidecar recap video
	recapVideo := filepath.Join(work, "recap_video.mp4")
	if err := concatRecapVideos(ctx, clipParts, recapVideo); err != nil {
		return fmt.Errorf("concatenating recap clips for %s: %w", videoPath, err)
	}
	recapAudio := filepath.Join(work, "recap_audio.wav")
	if err := concatWavs(ctx, wavParts, recapAudio); err != nil {
		return fmt.Errorf("concatenating recap narration for %s: %w", videoPath, err)
	}

	// the display caption belongs to the recap (derived) video, under its own
	// basename ("<name>.<lang>-recap.<lang>.srt"), so it associates to the recap
	// and not the parent.
	dispPath := video.GetCaptionPath(outPath, lang, "srt")
	if werr := os.WriteFile(dispPath, []byte(display.String()), 0644); werr != nil {
		logger.Warnf("[recap] could not write recap caption for %s: %v", videoPath, werr)
		dispPath = ""
	}

	if err := muxDub(ctx, recapVideo, recapAudio, dispPath, lang, outPath); err != nil {
		return fmt.Errorf("muxing recap for %s: %w", videoPath, err)
	}
	logger.Infof("[recap] generated %s (%.0fs, %d clips)", outPath, offset, len(clips))
	return nil
}

// renderRecapViaScript hands the whole render to an external script
// (render_recap.py) that adds an original-audio bed, one-line subtitles,
// loudness-normalization and truncation-safe dubbing. It feeds the recap beats
// (cue refs + narration) plus a numbered SRT mapping each cue number to its
// source time range; the script does its own clip-extract / dub / mux.
// Env: RECAP_PYTHON (default "python3"), RECAP_BED_VOL (default "0.6").
func renderRecapViaScript(ctx context.Context, script string, beats []recapBeat, cues []dubCue, videoPath, outPath, voice string) error {
	work, err := os.MkdirTemp("", "stash-recap-rr-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	data, err := json.Marshal(struct {
		Beats []recapBeat `json:"beats"`
	}{beats})
	if err != nil {
		return err
	}
	beatsPath := filepath.Join(work, "beats.json")
	if err := os.WriteFile(beatsPath, data, 0644); err != nil {
		return err
	}

	// minimal numbered SRT: block N carries cue N's time range. The renderer only
	// needs cue-number -> time, so the placeholder caption text is irrelevant.
	var sb strings.Builder
	for i, c := range cues {
		fmt.Fprintf(&sb, "%d\n%s --> %s\n.\n\n", i+1, secsToTimecode(c.start), secsToTimecode(c.end))
	}
	srtPath := filepath.Join(work, "cues.srt")
	if err := os.WriteFile(srtPath, []byte(sb.String()), 0644); err != nil {
		return err
	}

	python := os.Getenv("RECAP_PYTHON")
	if python == "" {
		python = "python3"
	}
	bedvol := os.Getenv("RECAP_BED_VOL")
	if bedvol == "" {
		bedvol = "0.6"
	}
	dubURL := config.GetInstance().GetDubbingURL() + dubbingPath

	// Have the script render to a temp name and rename into place on success,
	// so a failed or cancelled render never leaves a partial file at outPath
	// (which would suppress regeneration and be scanned in as a corrupt video).
	tmpOut := outPath + ".part.mp4"
	args := []string{script, beatsPath, srtPath, videoPath, tmpOut,
		"--dub-url", dubURL, "--bedvol", bedvol}
	if voice != "" {
		args = append(args, "--voice", voice)
	}
	cmd := exec.CommandContext(ctx, python, args...)
	out, runErr := cmd.CombinedOutput()
	if len(out) > 0 {
		logger.Debugf("[recap] render_recap: %s", strings.TrimSpace(string(out)))
	}
	if runErr != nil {
		_ = os.Remove(tmpOut)
		return fmt.Errorf("%w: %s", runErr, strings.TrimSpace(string(out)))
	}
	if _, serr := os.Stat(tmpOut); serr != nil {
		return fmt.Errorf("render script produced no output file: %w", serr)
	}
	return os.Rename(tmpOut, outPath)
}

// recapOutputPath returns "<dir>/<name>.<lang>-recap.mp4".
func recapOutputPath(videoPath, lang string) string {
	ext := filepath.Ext(videoPath)
	return strings.TrimSuffix(videoPath, ext) + "." + lang + "-recap.mp4"
}

// recapScriptPath returns "<dir>/<name>.recapscript.json" — the cached LLM plan
// (beats + chosen cues), for audit/regeneration. Ignored by the library watcher.
func recapScriptPath(videoPath string) string {
	ext := filepath.Ext(videoPath)
	return strings.TrimSuffix(videoPath, ext) + ".recapscript.json"
}

func writeRecapSkip(skipPath string) {
	if err := os.WriteFile(skipPath, []byte("recap produced nothing usable\n"), 0644); err != nil {
		logger.Warnf("[recap] could not write skip marker %s: %v", skipPath, err)
	}
}

// recapBeat is one narration unit returned by the recap service: the source cue
// indices (1-based, into the numbered transcript) to show, and the narration to
// speak over them.
type recapBeat struct {
	Cues []int  `json:"cues"`
	Text string `json:"text"`
}

// recapClip is a planned output segment: a resolved source time range and the
// narration to voice over it.
type recapClip struct {
	start, end float64
	text       string
}

// requestRecapScript posts the numbered transcript to the recap service and
// returns its ordered narration beats. The service wraps an LLM (claude -p) that
// selects cues and writes the narration; see .agents/ln3-recap/recap_server.py.
func requestRecapScript(ctx context.Context, transcript, lang string, maxMinutes int) ([]recapBeat, error) {
	cfg := config.GetInstance()
	serviceURL := cfg.GetRecapServiceURL() + recapPath

	// budget the narration to roughly the spoken-character capacity of the cap
	// (~5 Chinese chars/sec) so the script can't overshoot the length.
	maxChars := maxMinutes * 60 * 5

	form := url.Values{}
	form.Set("transcript", transcript)
	form.Set("target_lang", lang)
	form.Set("max_minutes", strconv.Itoa(maxMinutes))
	form.Set("max_chars", strconv.Itoa(maxChars))

	reqCtx, cancel := context.WithTimeout(ctx, cfg.GetRecapRequestTimeout())
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, serviceURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("recap service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out struct {
		Beats []recapBeat `json:"beats"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decoding recap response: %w", err)
	}
	return out.Beats, nil
}

// loadRecapTranscript returns the source cues plus a compact numbered transcript
// (one "N [mm:ss] text" line per cue) for the LLM to select from. It reuses an
// existing caption when present (translated target first, then source language),
// otherwise transcribes on demand via the subtitle task internals.
func loadRecapTranscript(ctx context.Context, repo models.Repository, scene models.Scene, videoPath string) ([]dubCue, string, error) {
	cfg := config.GetInstance()

	var srt string
	for _, p := range []string{
		video.GetCaptionPath(videoPath, cfg.GetSubtitleGenerationTranslateTo(), "srt"),
		video.GetCaptionPath(videoPath, cfg.GetSubtitleGenerationLanguage(), "srt"),
	} {
		if data, err := os.ReadFile(p); err == nil && strings.Contains(string(data), "-->") {
			srt = string(data)
			break
		}
	}

	if srt == "" {
		// transcribe on demand, reusing the subtitle task's ASR plumbing.
		sub := &GenerateSubtitlesTask{repository: repo, Scene: scene}
		tmp, err := os.CreateTemp("", "stash-recap-audio-*.wav")
		if err != nil {
			return nil, "", err
		}
		audioPath := tmp.Name()
		_ = tmp.Close()
		defer os.Remove(audioPath)

		if err := sub.extractAudio(ctx, videoPath, audioPath); err != nil {
			return nil, "", fmt.Errorf("extracting audio: %w", err)
		}
		body, _, err := sub.transcribe(ctx, audioPath, cfg.GetSubtitleGenerationLanguage())
		if err != nil {
			return nil, "", fmt.Errorf("transcribing: %w", err)
		}
		srt = body
	}

	cues := parseDubCues(srt)
	if len(cues) == 0 {
		return nil, "", nil
	}

	var b strings.Builder
	for i, c := range cues {
		line := strings.ReplaceAll(strings.TrimSpace(stripSpeakerTags(c.text)), "\n", " ")
		fmt.Fprintf(&b, "%d [%s] %s\n", i+1, mmss(c.start), line)
	}
	return cues, b.String(), nil
}

// planRecapClips resolves each beat's 1-based cue references into a source time
// range, clamps/orders them, and stops once the accumulated length reaches the
// cap (logging what was dropped rather than silently truncating).
func planRecapClips(beats []recapBeat, cues []dubCue, videoDur, maxDur float64) []recapClip {
	const minClip = 1.2

	var clips []recapClip
	total := 0.0
	for bi, b := range beats {
		text := strings.TrimSpace(b.Text)
		if text == "" || len(b.Cues) == 0 {
			continue
		}
		start, end := math.MaxFloat64, 0.0
		for _, idx := range b.Cues {
			if idx < 1 || idx > len(cues) {
				continue
			}
			c := cues[idx-1]
			if c.start < start {
				start = c.start
			}
			if c.end > end {
				end = c.end
			}
		}
		if start == math.MaxFloat64 || end <= start {
			continue
		}
		if start < 0 {
			start = 0
		}
		// Size each clip to the spoken length of its narration rather than the raw
		// cue span: clips whose cues are tight get EXTENDED so the synthesized
		// speech is never cut off mid-sentence, and clips whose cues sprawl get
		// TRIMMED so there's no long silent tail. ~4.5 zh chars/sec (a touch slower
		// than the dub's true rate) plus a 1s tail keeps the speech fully inside
		// the clip without overrun.
		spoken := float64(len([]rune(text)))/4.5 + 1.0
		if spoken < minClip {
			spoken = minClip
		}
		end = start + spoken
		if videoDur > 0 && end > videoDur {
			end = videoDur
		}
		if end-start < 0.2 {
			continue
		}
		dur := end - start
		if maxDur > 0 && total+dur > maxDur {
			logger.Infof("[recap] reached %.0fmin cap at %d clips; dropping beats %d..%d", maxDur/60, len(clips), bi+1, len(beats))
			break
		}
		clips = append(clips, recapClip{start: start, end: end, text: text})
		total += dur
	}
	return clips
}

// singleCueSRT builds a one-cue SRT spanning [0, dur] carrying the narration —
// the dub service fits the synthesized speech to that duration.
func singleCueSRT(text string, dur float64) string {
	if dur < 0.2 {
		dur = 0.2
	}
	return fmt.Sprintf("1\n%s --> %s\n%s\n", secsToTimecode(0), secsToTimecode(dur), strings.TrimSpace(text))
}

// mmss formats seconds as "MM:SS" for the numbered transcript.
func mmss(t float64) string {
	if t < 0 {
		t = 0
	}
	s := int(t + 0.5)
	return fmt.Sprintf("%02d:%02d", s/60, s%60)
}

// extractRecapClip cuts [start, start+dur] of videoPath and re-encodes it to a
// uniform H.264 profile (no audio) so the clips concatenate cleanly. SlowSeek
// keeps the cut frame-accurate (avoids green-frame artifacts on copy cuts).
func extractRecapClip(ctx context.Context, videoPath string, start, dur float64, outPath string) error {
	args := transcoder.Transcode(videoPath, transcoder.TranscodeOptions{
		StartTime:  start,
		Duration:   dur,
		SlowSeek:   true,
		VideoCodec: ffmpeg.VideoCodecLibX264,
		VideoArgs:  ffmpeg.Args{"-pix_fmt", "yuv420p", "-preset", "veryfast"},
		// AudioCodec unset => audio skipped (narration is muxed in later)
		Format:     ffmpeg.FormatMP4,
		OutputPath: outPath,
	})
	return instance.FFMpeg.Generate(ctx, args)
}

// concatRecapVideos concatenates equal-format clips via the concat demuxer.
func concatRecapVideos(ctx context.Context, parts []string, outPath string) error {
	listFile := outPath + ".concat.txt"
	var b strings.Builder
	for _, p := range parts {
		fmt.Fprintf(&b, "file '%s'\n", strings.ReplaceAll(p, "'", `'\''`))
	}
	if err := os.WriteFile(listFile, []byte(b.String()), 0644); err != nil {
		return err
	}
	defer os.Remove(listFile)

	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = append(args, "-f", "concat", "-safe", "0")
	args = args.Input(listFile)
	args = append(args, "-c", "copy")
	args = args.Overwrite()
	args = args.Output(outPath)
	return instance.FFMpeg.Generate(ctx, args)
}

// probeRecapDuration returns the actual duration of an extracted clip so the
// narration can be fit to it exactly.
func probeRecapDuration(path string) (float64, error) {
	vf, err := instance.FFProbe.NewVideoFile(path)
	if err != nil {
		return 0, err
	}
	if vf.VideoStreamDuration > 0 {
		return vf.VideoStreamDuration, nil
	}
	return vf.FileDuration, nil
}
