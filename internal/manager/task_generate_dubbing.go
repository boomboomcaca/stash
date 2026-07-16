package manager

import (
	"context"
	"fmt"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/ffmpeg"
	"github.com/stashapp/stash/pkg/file/video"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
)

const dubbingPath = "/v1/dub"

// GenerateDubbingTask produces a dubbed video for a scene. It sends the scene's
// already-translated caption (e.g. movie.zh.srt, produced by
// GenerateSubtitlesTask) to the dub service, which synthesizes a dubbed audio
// track via CosyVoice. That track is then muxed over the original video into a
// sidecar "<name>.<lang>-dub.mp4". The original video is left untouched.
//
// This standalone task only handles scenes whose translated caption already
// exists. When subtitles and dubbing are generated together in one run, the
// caption does not exist at queue time, so the dub is instead chained onto the
// subtitle task (see GenerateSubtitlesTask.Dub); both paths share dubScene.
type GenerateDubbingTask struct {
	repository models.Repository
	Scene      models.Scene
	Overwrite  bool
}

func (t *GenerateDubbingTask) GetDescription() string {
	return fmt.Sprintf("Generating dubbing for %s", t.Scene.Path)
}

// required reports whether dubbing should run for this scene. It is called
// within the generate job's read transaction.
func (t *GenerateDubbingTask) required(ctx context.Context) bool {
	f := t.Scene.Files.Primary()
	if f == nil {
		return false
	}
	if t.Overwrite {
		return true
	}
	target := config.GetInstance().GetSubtitleGenerationTranslateTo()
	// skip if a dubbed file already exists
	if _, err := os.Stat(dubOutputPath(f.Path, target)); err == nil {
		return false
	}
	// need a translated caption to dub from
	srtPath := video.GetCaptionPath(f.Path, target, "srt")
	if _, err := os.Stat(srtPath); err != nil {
		return false
	}
	// the target-named caption is the *source* caption when the detected source
	// language equals the target (no translation ran); dubScene skips those, so
	// don't queue them.
	if !hasNonTargetSubtitleSource(f.Path, target) {
		return false
	}
	return true
}

func (t *GenerateDubbingTask) Start(ctx context.Context) {
	if err := t.repository.WithReadTxn(ctx, func(ctx context.Context) error {
		return t.Scene.LoadPrimaryFile(ctx, t.repository.File)
	}); err != nil {
		logger.Errorf("[dubbing] error loading primary file for scene %d: %v", t.Scene.ID, err)
		return
	}

	f := t.Scene.Files.Primary()
	if f == nil {
		return
	}

	if err := dubScene(ctx, f.Path, f.Duration, t.Overwrite); err != nil {
		logger.Errorf("[dubbing] %v", err)
	}
}

// dubScene produces the sidecar dubbed video for videoPath from its translated
// caption (e.g. movie.zh.srt). It is shared by GenerateDubbingTask and the
// inline dub step that runs right after GenerateSubtitlesTask writes the
// translated caption, so a single generate run can produce captions and then
// dub from them. The original video is left untouched. A missing caption,
// unknown duration, or already-existing dub is treated as a skip (nil error).
func dubScene(ctx context.Context, videoPath string, duration float64, overwrite bool) error {
	cfg := config.GetInstance()
	target := cfg.GetSubtitleGenerationTranslateTo()

	outPath := dubOutputPath(videoPath, target)
	if !overwrite {
		if _, err := os.Stat(outPath); err == nil {
			return nil
		}
	}

	// the dub source is the tagged dub script when present (speaker + emotion
	// routing), else the parent's translated caption (older runs, single-speaker
	// content). this is only the dub *input* read below; the re-cut display
	// caption is written to the dub's own sidecar (dubCaptionPath).
	captionPath := video.GetCaptionPath(videoPath, target, "srt")
	// the re-cut display caption belongs to the *dubbed* video, so it lives under
	// the dub's own basename ("<name>.<lang>-dub.<lang>.srt"). Writing it under
	// the parent's name would associate it to the parent and — since ce439e431
	// stops derived videos inheriting the parent's captions — leave the dub with
	// no caption at all. It also no longer clobbers the parent's own caption.
	dubCaptionPath := video.GetCaptionPath(outPath, target, "srt")
	srtPath := dubScriptPath(videoPath, target)
	if _, err := os.Stat(srtPath); err != nil {
		srtPath = captionPath
	}
	srtBytes, err := os.ReadFile(srtPath)
	if err != nil {
		logger.Warnf("[dubbing] no %s caption for %s (%v); skipping", target, videoPath, err)
		return nil
	}

	// When the detected source language equals the translate target, no
	// translation ran and the target-named caption/script read above IS the
	// source transcript — "dubbing" would re-synthesize the video's own
	// dialogue in its own language. A real translation always leaves the
	// detected source language's caption beside the target one; skip when no
	// such sibling exists.
	if !hasNonTargetSubtitleSource(videoPath, target) {
		logger.Infof("[dubbing] %s caption for %s appears to be the source language (no translation found); skipping", target, videoPath)
		return nil
	}

	if duration <= 0 {
		logger.Warnf("[dubbing] unknown/zero duration for %s; skipping", videoPath)
		return nil
	}

	// fetch the dubbed audio track from the dub service
	tmp, err := os.CreateTemp("", "stash-dub-*.wav")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	dubAudioPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(dubAudioPath)

	// Long videos are dubbed in bounded, sequential, retryable windows instead of
	// one whole-video request: a single request (minutes-long synthesis + a large
	// background-audio upload) can hold the GPU-shared dub service long enough to
	// time out, get connection-reset, or wedge the service. Each window carries
	// only its own slice of the original audio as background, retries on transient
	// failure, and is forced to an exact length so windows concatenate in sync.
	// The chunked path uses the already-aligned translated caption for display
	// (no per-chunk recut). Short videos keep the single-request path, which also
	// supports the dub service's recut display caption and one-shot pace refit.
	// Default to NO caption: only the audio-aligned re-cut is ever shown on the
	// dubbed video; an original-timing caption would lag/lead the re-paced voice.
	displayCaption := ""
	if duration > cfg.GetDubbingChunkSeconds() {
		recut, err := synthDubChunked(ctx, videoPath, string(srtBytes), duration, cfg.GetDubbingVoice(), dubAudioPath)
		if err != nil {
			return fmt.Errorf("dub service error for %s: %w", videoPath, err)
		}
		// The dubbed (derived) video gets its own caption sidecar so it
		// associates in stash — derived videos don't inherit the parent's
		// captions (see dubCaptionPath above). Only the per-chunk re-cut caption
		// (clause-level lines timed to the synthesised audio) is shown; if the
		// service returns no re-cut, leave the dub with NO soft-sub rather than
		// the parent's original-timing caption.
		if strings.Contains(recut, "-->") {
			if werr := os.WriteFile(dubCaptionPath, []byte(recut), 0644); werr != nil {
				logger.Warnf("[dubbing] could not write dub caption for %s: %v", videoPath, werr)
			} else {
				displayCaption = dubCaptionPath
			}
		}
	} else {
		dc, err := dubSingleRequest(ctx, videoPath, string(srtBytes), duration, captionPath, dubCaptionPath, target, dubAudioPath)
		if err != nil {
			return err
		}
		displayCaption = dc
	}

	if displayCaption == "" {
		// This run produced no usable re-cut caption, but an overwrite re-dub
		// may have left a previous run's sidecar behind — timed to audio we
		// just replaced, it would drift against the new voice track (the same
		// hazard the refit branch handles). Remove it and mux audio-only.
		_ = os.Remove(dubCaptionPath)
	}

	// mux the dubbed audio over the original video into the sidecar file;
	// the soft-sub track is always the CLEAN caption, never the tagged script
	if err := muxDub(ctx, videoPath, dubAudioPath, displayCaption, target, outPath); err != nil {
		return fmt.Errorf("muxing dubbed video for %s: %w", videoPath, err)
	}
	logger.Infof("[dubbing] generated dubbed video %s", outPath)
	return nil
}

// dubOutputPath returns "<dir>/<name>.<lang>-dub.mp4".
func dubOutputPath(videoPath, lang string) string {
	ext := filepath.Ext(videoPath)
	return strings.TrimSuffix(videoPath, ext) + "." + lang + "-dub.mp4"
}

// dubScriptPath returns "<dir>/<name>.<lang>.srt.dub" — the tagged dub script
// ("[Speaker N|情绪]: " prefixes for voice/emotion routing) kept beside the
// clean display caption; deliberately not ".srt" so caption scans ignore it.
func dubScriptPath(videoPath, lang string) string {
	return video.GetCaptionPath(videoPath, lang, "srt") + ".dub"
}

// hasNonTargetSubtitleSource reports whether videoPath has a sibling caption or
// dub script ("<base>.<lang>.srt" / "<base>.<lang>.srt.dub") in a language
// other than target. GenerateSubtitlesTask always writes the detected
// source-language caption before translating, so its absence means the
// target-named caption IS the source caption (detected source language ==
// target) and no translation ever ran.
func hasNonTargetSubtitleSource(videoPath, target string) bool {
	dir := filepath.Dir(videoPath)
	ext := filepath.Ext(videoPath)
	prefix := filepath.Base(strings.TrimSuffix(videoPath, ext)) + "."
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		lang := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".dub")
		if !strings.HasSuffix(lang, ".srt") {
			continue
		}
		lang = strings.TrimSuffix(lang, ".srt")
		// a single dot-free language token; anything else belongs to a sibling
		// or derived video ("movie.2.en.srt", "movie.zh-dub.zh.srt")
		if lang != "" && lang != target && !strings.Contains(lang, ".") {
			return true
		}
	}
	return false
}

// findSourceDubScript returns the tagged dub-script whose language is NOT the
// translation target ("<base>.<srcLang>.srt.dub") — the source-language script
// written by GenerateSubtitlesTask under whatever language ASR detected. Empty
// if none is found. Used by the pace-refit re-translation so it works even when
// the detected source language differs from the configured default.
func findSourceDubScript(videoPath, target string) string {
	// List the directory instead of filepath.Glob: the video basename is
	// user-controlled and commonly contains glob metacharacters (e.g. release
	// tags like "[1080p]"), which would turn the pattern into a character class —
	// matching nothing (or erroring on an unbalanced bracket) and silently
	// disabling the pace refit this helper exists to enable.
	dir := filepath.Dir(videoPath)
	ext := filepath.Ext(videoPath)
	prefix := filepath.Base(strings.TrimSuffix(videoPath, ext)) + "."
	targetName := filepath.Base(dubScriptPath(videoPath, target))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if name == targetName {
			continue
		}
		if strings.HasPrefix(name, prefix) && strings.HasSuffix(name, ".srt.dub") {
			// the segment between the basename and ".srt.dub" must be a single
			// language token: "movie.2.en.srt.dub" belongs to the sibling video
			// "movie.2.mp4", not to "movie.mp4" — returning it would re-dub this
			// video with another video's dialogue.
			lang := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".srt.dub")
			if lang != "" && !strings.Contains(lang, ".") {
				return filepath.Join(dir, name)
			}
		}
	}
	return ""
}

// requestDub posts the SRT to the dub service /v1/dub and streams the returned
// wav to outPath. When bgAudioPath is non-empty, the request is sent as
// multipart with the original audio attached as bg_audio so the service remixes
// the background; otherwise a plain url-encoded form is used. recut=1 asks the
// service to also return a clause-level display caption re-cut from the dub
// audio; the response is then multipart/mixed (audio part + recut SRT part).
//
// Returns the re-cut display SRT (empty when the service is an old build that
// returns plain audio) and the X-Dub-Cps-Refit flag (this scene's measured
// speaking rate disagreed with the translation's budget assumption).
func requestDub(ctx context.Context, srt string, duration float64, voice, bgAudioPath, outPath string) (string, bool, error) {
	serviceURL := config.GetInstance().GetDubbingURL() + dubbingPath
	durStr := strconv.FormatFloat(duration, 'f', 3, 64)

	var req *http.Request
	var err error
	if bgAudioPath == "" {
		form := url.Values{}
		form.Set("text", srt)
		form.Set("duration", durStr)
		form.Set("voice", voice)
		form.Set("recut", "1")
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, serviceURL, strings.NewReader(form.Encode()))
		if err != nil {
			return "", false, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		pr, pw := io.Pipe()
		mw := multipart.NewWriter(pw)
		go func() {
			werr := func() error {
				if err := mw.WriteField("text", srt); err != nil {
					return err
				}
				if err := mw.WriteField("duration", durStr); err != nil {
					return err
				}
				if err := mw.WriteField("voice", voice); err != nil {
					return err
				}
				if err := mw.WriteField("recut", "1"); err != nil {
					return err
				}
				bf, err := os.Open(bgAudioPath)
				if err != nil {
					return err
				}
				defer bf.Close()
				part, err := mw.CreateFormFile("bg_audio", filepath.Base(bgAudioPath))
				if err != nil {
					return err
				}
				if _, err := io.Copy(part, bf); err != nil {
					return err
				}
				return mw.Close()
			}()
			_ = pw.CloseWithError(werr)
		}()
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, serviceURL, pr)
		if err != nil {
			_ = pr.CloseWithError(err) // unblock the multipart writer goroutine parked on pw.Write
			return "", false, err
		}
		req.Header.Set("Content-Type", mw.FormDataContentType())
	}

	// no client timeout: synthesizing a full video can take minutes; cancellation
	// is handled via the request context.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", false, fmt.Errorf("dub service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	refit := resp.Header.Get("X-Dub-Cps-Refit") == "1"

	mediaType, params, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if strings.HasPrefix(mediaType, "multipart/") {
		recut, err := streamMultipartDub(resp.Body, params["boundary"], outPath)
		if err != nil {
			return "", refit, err
		}
		if recut == "" {
			logger.Warnf("[dubbing] multipart dub response carried no re-cut caption")
		}
		return recut, refit, nil
	}

	// legacy / recut-off path: the whole body is the wav, streamed to disk.
	out, err := os.Create(outPath)
	if err != nil {
		return "", false, err
	}
	defer out.Close()
	if _, err := io.Copy(out, resp.Body); err != nil {
		return "", false, err
	}
	return "", refit, nil
}

// streamMultipartDub splits a multipart/mixed dub response: the audio part is
// streamed to outPath (never buffered), the text part is read into the returned
// re-cut SRT string.
func streamMultipartDub(body io.Reader, boundary, outPath string) (string, error) {
	if boundary == "" {
		return "", fmt.Errorf("multipart dub response missing boundary")
	}
	mr := multipart.NewReader(body, boundary)
	var recut string
	wroteAudio := false
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		ct, _, _ := mime.ParseMediaType(p.Header.Get("Content-Type"))
		if strings.HasPrefix(ct, "audio/") {
			out, cerr := os.Create(outPath)
			if cerr != nil {
				p.Close()
				return "", cerr
			}
			_, cerr = io.Copy(out, p)
			out.Close()
			p.Close()
			if cerr != nil {
				return "", cerr
			}
			wroteAudio = true
		} else if strings.HasPrefix(ct, "text/") || strings.Contains(ct, "subrip") || p.FormName() == "recut_srt" {
			b, rerr := io.ReadAll(p)
			p.Close()
			if rerr != nil {
				return "", rerr
			}
			recut = string(b)
		} else {
			p.Close()
		}
	}
	if !wroteAudio {
		return "", fmt.Errorf("multipart dub response carried no audio part")
	}
	return recut, nil
}

// dubSingleRequest dubs the whole video in one request (short videos). It sends
// the scene's background audio for remix, applies the dub service's recut
// display caption, and performs the one-shot pace-refit re-dub. It returns the
// display caption path to mux.
func dubSingleRequest(ctx context.Context, videoPath, srt string, duration float64, captionPath, dubCaptionPath, target, dubAudioPath string) (string, error) {
	cfg := config.GetInstance()
	_ = captionPath // parent caption is intentionally never shown on the dubbed video
	// Default to NO caption: only the audio-aligned re-cut becomes the display
	// caption below; otherwise the dub is muxed with no soft-sub.
	displayCaption := ""

	// hand the dub service the scene's original audio so it separates and remixes
	// the music/SFX under the dubbed voice. extraction or upload failures degrade
	// gracefully to a voice-only dub.
	var bgAudioPath string
	bgTmp, berr := os.CreateTemp("", "stash-dubbg-*.wav")
	if berr != nil {
		logger.Warnf("[dubbing] could not create background temp for %s (%v); dubbing voice-only", videoPath, berr)
	} else {
		bgAudioPath = bgTmp.Name()
		_ = bgTmp.Close()
		defer os.Remove(bgAudioPath)
		if berr := extractDubBackground(ctx, videoPath, bgAudioPath); berr != nil {
			logger.Warnf("[dubbing] could not extract background audio from %s (%v); dubbing voice-only", videoPath, berr)
			bgAudioPath = ""
		}
	}

	recut, refit, err := requestDub(ctx, srt, duration, cfg.GetDubbingVoice(), bgAudioPath, dubAudioPath)
	if err != nil {
		return "", fmt.Errorf("dub service error for %s: %w", videoPath, err)
	}
	// The dub re-cut the unit-level Chinese into clause-level display lines timed
	// to the synthesized audio; falls back to the parent caption only for a legacy
	// dub service that returns no re-cut.
	if strings.Contains(recut, "-->") {
		if werr := os.WriteFile(dubCaptionPath, []byte(recut), 0644); werr != nil {
			logger.Warnf("[dubbing] could not write re-cut caption for %s: %v", videoPath, werr)
		} else {
			displayCaption = dubCaptionPath
		}
	}

	// One-shot pace convergence: the dub measured this scene's cloned voices
	// speaking at a rate that disagrees with the budget the translation assumed.
	if refit {
		// The source tagged dub-script is written under the language ASR actually
		// detected, which can differ from the configured default; discover it
		// rather than assuming the default (else refit silently never fires).
		srcScript := findSourceDubScript(videoPath, target)
		if srcScript == "" {
			srcScript = dubScriptPath(videoPath, cfg.GetSubtitleGenerationLanguage())
		}
		if enTagged, rerr := os.ReadFile(srcScript); rerr == nil {
			logger.Infof("[dubbing] pace calibration shifted; re-translating %s with the measured rate", videoPath)
			retrans, terr := translateSRT(ctx, string(enTagged), target)
			if terr == nil && strings.Contains(retrans, "-->") {
				_ = os.WriteFile(dubScriptPath(videoPath, target), []byte(retrans), 0644)
				recut2, _, derr := requestDub(ctx, retrans, duration, cfg.GetDubbingVoice(), bgAudioPath, dubAudioPath)
				if derr != nil {
					return "", fmt.Errorf("dub service error (refit) for %s: %w", videoPath, derr)
				}
				// only the audio-aligned re-cut becomes the display caption
				if strings.Contains(recut2, "-->") {
					_ = os.WriteFile(dubCaptionPath, []byte(recut2), 0644)
					displayCaption = dubCaptionPath
				} else if displayCaption == dubCaptionPath {
					// The refit re-dub wrote fresh audio to dubAudioPath but
					// returned no re-cut caption. The caption still on disk was
					// timed to the first dub's (now-overwritten) audio, so muxing
					// it against the refit audio would drift; drop it and let
					// muxDub fall back to audio-only.
					_ = os.Remove(dubCaptionPath)
					displayCaption = ""
				}
			} else if terr != nil {
				logger.Warnf("[dubbing] refit re-translation failed (%v); keeping the first dub", terr)
			}
		}
	}
	return displayCaption, nil
}

// dubCue is one parsed subtitle cue. Timecodes are in seconds; text may carry
// the "[Speaker N]: " dub-routing prefix, which is preserved so the dub service
// still gets per-speaker voice routing within each chunk.
type dubCue struct {
	start, end float64
	text       string
}

var srtTimecodeRE = regexp.MustCompile(`(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)`)

// parseDubCues parses an SRT body into cues, ignoring malformed blocks.
func parseDubCues(srt string) []dubCue {
	var cues []dubCue
	for _, block := range strings.Split(strings.ReplaceAll(srt, "\r\n", "\n"), "\n\n") {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) < 3 {
			continue
		}
		m := srtTimecodeRE.FindStringSubmatch(lines[1])
		if m == nil {
			continue
		}
		toSecs := func(h, mi, s, ms string) float64 {
			hi, _ := strconv.Atoi(h)
			mii, _ := strconv.Atoi(mi)
			si, _ := strconv.Atoi(s)
			msi, _ := strconv.Atoi(ms)
			return float64(hi*3600+mii*60+si) + float64(msi)/1000
		}
		cues = append(cues, dubCue{
			start: toSecs(m[1], m[2], m[3], m[4]),
			end:   toSecs(m[5], m[6], m[7], m[8]),
			text:  strings.Join(lines[2:], "\n"),
		})
	}
	return cues
}

// secsToTimecode formats seconds as an SRT timecode "HH:MM:SS,mmm".
func secsToTimecode(t float64) string {
	if t < 0 {
		t = 0
	}
	ms := int(math.Round(t * 1000))
	h := ms / 3600000
	ms %= 3600000
	m := ms / 60000
	ms %= 60000
	s := ms / 1000
	ms %= 1000
	return fmt.Sprintf("%02d:%02d:%02d,%03d", h, m, s, ms)
}

// chunkDubSRT returns the SRT for the window [t0,t1) with timestamps rebased to
// t0 and clamped into [0, t1-t0], plus the number of cues it contains.
func chunkDubSRT(cues []dubCue, t0, t1 float64) (string, int) {
	dur := t1 - t0
	var b strings.Builder
	n := 0
	for _, c := range cues {
		// Assign each cue to EXACTLY ONE window — the one its start falls in. The
		// old overlap test (start<t1 && end>t0) put a cue that straddles a window
		// edge into BOTH adjacent windows, so the boundary sentence was dubbed and
		// captioned twice (duplicate audio + repeated subtitle).
		if c.start < t0-0.01 || c.start >= t1-0.01 {
			continue
		}
		a := c.start - t0
		if a < 0 {
			a = 0
		}
		if a > dur {
			a = dur
		}
		e := c.end - t0
		if e > dur {
			e = dur
		}
		if e < a+0.2 {
			e = a + 0.2
		}
		if e > dur {
			e = dur
		}
		n++
		fmt.Fprintf(&b, "%d\n%s --> %s\n%s\n\n", n, secsToTimecode(a), secsToTimecode(e), c.text)
	}
	return b.String(), n
}

// synthDubChunked produces the full dubbed audio for videoPath by sending the
// dub script to the dub service in bounded, sequential, retryable windows. Each
// window's audio is forced to its exact length so windows concatenate without
// drift; the result spans the full video. A window with no cues becomes local
// silence (no service call). The concatenated track is written to outAudioPath.
func synthDubChunked(ctx context.Context, videoPath, srt string, totalDur float64, voice, outAudioPath string) (string, error) {
	cfg := config.GetInstance()
	chunk := cfg.GetDubbingChunkSeconds()
	retries := cfg.GetDubbingChunkRetries()
	timeout := cfg.GetDubbingRequestTimeout()
	cues := parseDubCues(srt)

	work, err := os.MkdirTemp("", "stash-dubchunk-")
	if err != nil {
		return "", fmt.Errorf("creating chunk workdir: %w", err)
	}
	defer os.RemoveAll(work)

	nChunks := int(math.Ceil(totalDur / chunk))
	var parts []string
	var recut strings.Builder // per-chunk re-cut display captions, spliced onto the global timeline
	recutN := 0
	k := 0
	for t0 := 0.0; t0 < totalDur-0.05; {
		// Snap the window end to a cue-start gap so no cue straddles two windows
		// (the old fixed t0+chunk edge dubbed boundary sentences twice). Every cue
		// starting before the nominal cut joins this window; the window ends at the
		// next cue's start, so windows tile the timeline without overlap or split.
		t1 := math.Min(t0+chunk, totalDur)
		if t1 < totalDur {
			// Only snap the window end forward when a cue actually straddles the
			// nominal cut (start < cut < end). Snapping unconditionally would
			// stretch the window across a dialogue gap all the way to the next
			// cue (or EOF), defeating the chunk-size cap and producing an
			// oversized synthesis request / background-audio upload.
			straddle := false
			for _, c := range cues {
				if c.start < t0+chunk-0.01 && c.end > t0+chunk+0.01 {
					straddle = true
					break
				}
			}
			if straddle {
				next := totalDur
				for _, c := range cues {
					if c.start >= t0+chunk-0.01 {
						next = c.start
						break
					}
				}
				// Extend only far enough to contain the straddling cue(s).
				// Snapping all the way to the next cue's start would stretch
				// the window across a dialogue gap (or to EOF when the
				// straddler is the last cue), recreating exactly the oversized
				// request the chunking exists to prevent. No cue starts in
				// (cut, next), so ending the window at the straddler's end
				// still assigns every cue to exactly one window.
				straddleEnd := t0 + chunk
				for _, c := range cues {
					if c.start < t0+chunk-0.01 && c.end > straddleEnd {
						straddleEnd = c.end
					}
				}
				t1 = math.Min(math.Min(next, straddleEnd), totalDur)
			}
		}
		if t1 <= t0 {
			t1 = math.Min(t0+chunk, totalDur)
		}
		dur := t1 - t0
		sub, nCues := chunkDubSRT(cues, t0, t1)
		raw := filepath.Join(work, fmt.Sprintf("r%d.wav", k))

		if nCues == 0 {
			if err := generateSilenceWav(ctx, dur, raw); err != nil {
				return "", fmt.Errorf("dub chunk %d silence: %w", k+1, err)
			}
		} else {
			var bgPath string
			bgw := filepath.Join(work, fmt.Sprintf("bg%d.wav", k))
			if berr := extractDubBackgroundWindow(ctx, videoPath, t0, dur, bgw); berr == nil {
				bgPath = bgw
			} else {
				logger.Warnf("[dubbing] chunk %d background extract failed (%v); voice-only", k+1, berr)
			}
			var chunkRecut string
			var derr error
			for attempt := 1; attempt <= retries; attempt++ {
				rctx, cancel := context.WithTimeout(ctx, timeout)
				chunkRecut, derr = postDubChunk(rctx, sub, dur, voice, bgPath, raw)
				cancel()
				if derr == nil {
					break
				}
				logger.Warnf("[dubbing] chunk %d/%d [%.0f-%.0fs] attempt %d/%d failed: %v", k+1, nChunks, t0, t1, attempt, retries, derr)
				select {
				case <-ctx.Done():
					return "", ctx.Err()
				case <-time.After(5 * time.Second):
				}
			}
			if derr != nil {
				return "", fmt.Errorf("dub chunk %d [%.0f-%.0fs] failed after %d attempts: %w", k+1, t0, t1, retries, derr)
			}
			// splice this window's re-cut caption onto the global timeline
			for _, c := range parseDubCues(chunkRecut) {
				recutN++
				fmt.Fprintf(&recut, "%d\n%s --> %s\n%s\n\n", recutN,
					secsToTimecode(c.start+t0), secsToTimecode(c.end+t0), c.text)
			}
		}

		fixed := filepath.Join(work, fmt.Sprintf("f%d.wav", k))
		if err := padTrimWav(ctx, raw, dur, fixed); err != nil {
			return "", fmt.Errorf("dub chunk %d normalise: %w", k+1, err)
		}
		parts = append(parts, fixed)
		logger.Infof("[dubbing] chunk %d/%d [%.0f-%.0fs] %d cues done", k+1, nChunks, t0, t1, nCues)
		k++
		t0 = t1
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("no dub chunks produced for %s", videoPath)
	}
	if err := concatWavs(ctx, parts, outAudioPath); err != nil {
		return "", err
	}
	return recut.String(), nil
}

// postDubChunk sends one dub window (text + duration + optional background audio)
// to the dub service, streams the returned wav to outPath, and returns the
// service's re-cut display SRT for this window (clause-level lines timed to the
// synthesised audio, with timestamps relative to the window). The caller splices
// these onto the global timeline. Empty when the service returns plain audio.
func postDubChunk(ctx context.Context, srt string, duration float64, voice, bgAudioPath, outPath string) (string, error) {
	serviceURL := config.GetInstance().GetDubbingURL() + dubbingPath
	durStr := strconv.FormatFloat(duration, 'f', 3, 64)

	var req *http.Request
	var err error
	if bgAudioPath == "" {
		form := url.Values{}
		form.Set("text", srt)
		form.Set("duration", durStr)
		form.Set("voice", voice)
		form.Set("recut", "1")
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, serviceURL, strings.NewReader(form.Encode()))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		pr, pw := io.Pipe()
		mw := multipart.NewWriter(pw)
		go func() {
			werr := func() error {
				if err := mw.WriteField("text", srt); err != nil {
					return err
				}
				if err := mw.WriteField("duration", durStr); err != nil {
					return err
				}
				if err := mw.WriteField("voice", voice); err != nil {
					return err
				}
				if err := mw.WriteField("recut", "1"); err != nil {
					return err
				}
				bf, err := os.Open(bgAudioPath)
				if err != nil {
					return err
				}
				defer bf.Close()
				part, err := mw.CreateFormFile("bg_audio", filepath.Base(bgAudioPath))
				if err != nil {
					return err
				}
				if _, err := io.Copy(part, bf); err != nil {
					return err
				}
				return mw.Close()
			}()
			_ = pw.CloseWithError(werr)
		}()
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, serviceURL, pr)
		if err != nil {
			_ = pr.CloseWithError(err) // unblock the multipart writer goroutine parked on pw.Write
			return "", err
		}
		req.Header.Set("Content-Type", mw.FormDataContentType())
	}

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("dub service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	mediaType, params, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if strings.HasPrefix(mediaType, "multipart/") {
		return streamMultipartDub(resp.Body, params["boundary"], outPath)
	}
	out, err := os.Create(outPath)
	if err != nil {
		return "", err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return "", err
}

// extractDubBackgroundWindow extracts [t0, t0+dur] of videoPath's audio to a
// stereo 44.1kHz wav, for the dub service to remix under that window's voice.
func extractDubBackgroundWindow(ctx context.Context, videoPath string, t0, dur float64, outPath string) error {
	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = append(args, "-ss", strconv.FormatFloat(t0, 'f', 3, 64))
	args = args.Input(videoPath)
	args = append(args, "-t", strconv.FormatFloat(dur, 'f', 3, 64))
	args = args.SkipVideo()
	args = append(args, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav")
	args = args.Overwrite()
	args = args.Output(outPath)
	return instance.FFMpeg.Generate(ctx, args)
}

// generateSilenceWav writes dur seconds of stereo 44.1kHz silence.
func generateSilenceWav(ctx context.Context, dur float64, outPath string) error {
	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = append(args, "-f", "lavfi", "-t", strconv.FormatFloat(dur, 'f', 3, 64), "-i", "anullsrc=r=44100:cl=stereo")
	args = append(args, "-c:a", "pcm_s16le", "-f", "wav")
	args = args.Overwrite()
	args = args.Output(outPath)
	return instance.FFMpeg.Generate(ctx, args)
}

// padTrimWav forces inPath to exactly dur seconds (pad with silence, then trim)
// so dub windows concatenate without accumulating drift.
func padTrimWav(ctx context.Context, inPath string, dur float64, outPath string) error {
	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = args.Input(inPath)
	args = args.AudioFilter(ffmpeg.AudioFilter("apad,atrim=0:" + strconv.FormatFloat(dur, 'f', 3, 64)))
	args = append(args, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav")
	args = args.Overwrite()
	args = args.Output(outPath)
	return instance.FFMpeg.Generate(ctx, args)
}

// concatWavs concatenates equal-format wav parts into one wav via the concat
// demuxer.
func concatWavs(ctx context.Context, parts []string, outPath string) error {
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

// extractDubBackground extracts the scene's original audio to a stereo 44.1kHz
// wav at outPath, suitable for the dub service to source-separate and remix the
// music/SFX under the dubbed voice.
func extractDubBackground(ctx context.Context, videoPath, outPath string) error {
	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = args.Input(videoPath)
	args = args.SkipVideo()
	args = append(args, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav")
	args = args.Overwrite()
	args = args.Output(outPath)
	return instance.FFMpeg.Generate(ctx, args)
}

// muxDub writes a sidecar mp4 with the original video stream, the dubbed audio,
// and (when available) the translated caption as a soft subtitle track. A
// missing or empty caption is muxed as video+audio only rather than aborting the
// whole dub — the caption is a convenience track, not a hard requirement.
func muxDub(ctx context.Context, videoPath, dubAudioPath, srtPath, lang, outPath string) error {
	hasSub := false
	if data, err := os.ReadFile(srtPath); err == nil && strings.Contains(string(data), "-->") {
		hasSub = true
	}

	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = args.Input(videoPath)
	args = args.Input(dubAudioPath)
	if hasSub {
		args = args.Input(srtPath)
	}
	// No -shortest: the soft-sub track ends at the last caption (before the
	// video's tail), and -shortest would truncate the whole output there,
	// dropping the post-narration outro. The dubbed audio already spans the full
	// video, so the output keeps the original length.
	args = append(args, "-map", "0:v:0", "-map", "1:a:0")
	if hasSub {
		args = append(args, "-map", "2:0")
	}
	args = append(args, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k")
	if hasSub {
		args = append(args, "-c:s", "mov_text", "-metadata:s:s:0", "language="+lang)
	}
	args = args.Overwrite()
	// Mux to a temp name and rename into place on success: ffmpeg leaves a
	// partial file behind on error/cancel, which would otherwise sit at outPath
	// forever — suppressing regeneration (required()/the non-overwrite guards
	// only stat the path) and getting scanned in as a corrupt video. Keep the
	// .mp4 extension so ffmpeg still infers the container.
	tmpOut := outPath + ".part.mp4"
	args = args.Output(tmpOut)
	if err := instance.FFMpeg.Generate(ctx, args); err != nil {
		_ = os.Remove(tmpOut)
		return err
	}
	return os.Rename(tmpOut, outPath)
}
