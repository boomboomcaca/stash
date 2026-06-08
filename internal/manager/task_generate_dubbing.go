package manager

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

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
	// skip if a dubbed file already exists
	if _, err := os.Stat(t.dubOutputPath(f.Path)); err == nil {
		return false
	}
	// need a translated caption to dub from
	srtPath := video.GetCaptionPath(f.Path, config.GetInstance().GetSubtitleGenerationTranslateTo(), "srt")
	if _, err := os.Stat(srtPath); err != nil {
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
	videoPath := f.Path
	cfg := config.GetInstance()
	target := cfg.GetSubtitleGenerationTranslateTo()

	outPath := t.dubOutputPath(videoPath)
	if !t.Overwrite {
		if _, err := os.Stat(outPath); err == nil {
			return
		}
	}

	// the dub source is the translated caption (e.g. movie.zh.srt)
	srtPath := video.GetCaptionPath(videoPath, target, "srt")
	srtBytes, err := os.ReadFile(srtPath)
	if err != nil {
		logger.Warnf("[dubbing] no %s caption for %s (%v); skipping", target, videoPath, err)
		return
	}

	duration := f.Duration
	if duration <= 0 {
		logger.Warnf("[dubbing] unknown/zero duration for %s; skipping", videoPath)
		return
	}

	// fetch the dubbed audio track from the dub service
	tmp, err := os.CreateTemp("", "stash-dub-*.wav")
	if err != nil {
		logger.Errorf("[dubbing] error creating temp file: %v", err)
		return
	}
	dubAudioPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(dubAudioPath)

	if err := t.requestDub(ctx, string(srtBytes), duration, cfg.GetDubbingVoice(), dubAudioPath); err != nil {
		logger.Errorf("[dubbing] dub service error for %s: %v", videoPath, err)
		return
	}

	// mux the dubbed audio over the original video into the sidecar file
	if err := t.mux(ctx, videoPath, dubAudioPath, srtPath, target, outPath); err != nil {
		logger.Errorf("[dubbing] error muxing dubbed video for %s: %v", videoPath, err)
		return
	}
	logger.Infof("[dubbing] generated dubbed video %s", outPath)
}

// dubOutputPath returns "<dir>/<name>.<lang>-dub.mp4".
func (t *GenerateDubbingTask) dubOutputPath(videoPath string) string {
	lang := config.GetInstance().GetSubtitleGenerationTranslateTo()
	ext := filepath.Ext(videoPath)
	return strings.TrimSuffix(videoPath, ext) + "." + lang + "-dub.mp4"
}

// requestDub posts the SRT to the dub service /v1/dub and streams the returned
// wav to outPath.
func (t *GenerateDubbingTask) requestDub(ctx context.Context, srt string, duration float64, voice, outPath string) error {
	serviceURL := config.GetInstance().GetDubbingURL() + dubbingPath
	form := url.Values{}
	form.Set("text", srt)
	form.Set("duration", strconv.FormatFloat(duration, 'f', 3, 64))
	form.Set("voice", voice)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serviceURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	// no client timeout: synthesizing a full video can take minutes; cancellation
	// is handled via the request context.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("dub service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, resp.Body); err != nil {
		return err
	}
	return nil
}

// mux writes a sidecar mp4 with the original video stream, the dubbed audio, and
// the translated caption as a soft subtitle track.
func (t *GenerateDubbingTask) mux(ctx context.Context, videoPath, dubAudioPath, srtPath, lang, outPath string) error {
	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = args.Input(videoPath)
	args = args.Input(dubAudioPath)
	args = args.Input(srtPath)
	args = append(args,
		"-map", "0:v:0", "-map", "1:a:0", "-map", "2:0",
		"-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
		"-c:s", "mov_text", "-metadata:s:s:0", "language="+lang,
		"-shortest",
	)
	args = args.Overwrite()
	args = args.Output(outPath)
	return instance.FFMpeg.Generate(ctx, args)
}
