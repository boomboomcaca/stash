package manager

import (
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/ffmpeg"
	"github.com/stashapp/stash/pkg/file/video"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/txn"
)

const subtitleTranscribePath = "/v1/audio/transcriptions"

// GenerateSubtitlesTask generates a caption (subtitle) file for a scene's
// primary video file by sending its audio to an external ASR service
// (parakeet-api). It only targets videos that do not already have captions,
// so already-subtitled content (e.g. Chinese videos with sidecar subs) is
// skipped. parakeet does not support Chinese; the configured language
// (default "en") is sent as the transcription prompt.
type GenerateSubtitlesTask struct {
	repository models.Repository
	Scene      models.Scene
	Overwrite  bool
}

func (t *GenerateSubtitlesTask) GetDescription() string {
	return fmt.Sprintf("Generating subtitles for %s", t.Scene.Path)
}

// required reports whether subtitles should be generated for this scene.
// It is called within the generate job's read transaction.
func (t *GenerateSubtitlesTask) required(ctx context.Context) bool {
	f := t.Scene.Files.Primary()
	if f == nil {
		return false
	}

	if t.Overwrite {
		return true
	}

	// skip scenes that already have captions
	captions, err := t.repository.File.GetCaptions(ctx, f.Base().ID)
	if err != nil {
		logger.Errorf("[subtitles] error getting captions for %s: %v", f.Path, err)
		return false
	}

	return len(captions) == 0
}

func (t *GenerateSubtitlesTask) Start(ctx context.Context) {
	f := t.Scene.Files.Primary()
	if f == nil {
		return
	}

	fileID := f.Base().ID
	videoPath := f.Path
	lang := config.GetInstance().GetSubtitleGenerationLanguage()

	// re-check captions here in case they were added since queuing
	if !t.Overwrite {
		var existing []*models.VideoCaption
		if err := t.repository.WithReadTxn(ctx, func(ctx context.Context) error {
			var err error
			existing, err = t.repository.File.GetCaptions(ctx, fileID)
			return err
		}); err != nil {
			logger.Errorf("[subtitles] error getting captions for %s: %v", videoPath, err)
			return
		}
		if len(existing) > 0 {
			return
		}
	}

	// extract audio to a temporary 16kHz mono wav for transcription.
	// CreateTemp guarantees a unique name so parallel tasks don't collide.
	tmp, err := os.CreateTemp("", "stash-asr-*.wav")
	if err != nil {
		logger.Errorf("[subtitles] error creating temp file: %v", err)
		return
	}
	audioPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(audioPath)

	if err := t.extractAudio(ctx, videoPath, audioPath); err != nil {
		logger.Errorf("[subtitles] error extracting audio from %s: %v", videoPath, err)
		return
	}

	srt, err := t.transcribe(ctx, audioPath, lang)
	if err != nil {
		logger.Errorf("[subtitles] error transcribing %s: %v", videoPath, err)
		return
	}

	// guard against empty or non-SRT responses (e.g. very short clips return
	// plain text without timestamps, which is not a usable caption)
	if !strings.Contains(srt, "-->") {
		logger.Warnf("[subtitles] ASR service returned no usable subtitles for %s", videoPath)
		return
	}

	captionPath := video.GetCaptionPath(videoPath, lang, "srt")
	if err := os.WriteFile(captionPath, []byte(srt), 0644); err != nil {
		logger.Errorf("[subtitles] error writing caption file %s: %v", captionPath, err)
		return
	}

	if err := t.associateCaption(ctx, fileID, captionPath, lang); err != nil {
		logger.Errorf("[subtitles] error associating caption for %s: %v", videoPath, err)
		return
	}

	logger.Infof("[subtitles] generated %s caption for %s", lang, videoPath)
}

// extractAudio extracts the audio track of videoPath to a 16kHz mono wav at
// audioPath, matching the input parakeet expects.
func (t *GenerateSubtitlesTask) extractAudio(ctx context.Context, videoPath, audioPath string) error {
	args := ffmpeg.Args{}.LogLevel(ffmpeg.LogLevelError)
	args = args.Input(videoPath)
	args = args.SkipVideo()
	args = append(args, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav")
	args = args.Overwrite()
	args = args.Output(audioPath)

	return instance.FFMpeg.Generate(ctx, args)
}

// transcribe uploads the audio file to the ASR service and returns the SRT body.
func (t *GenerateSubtitlesTask) transcribe(ctx context.Context, audioPath, lang string) (string, error) {
	serviceURL := config.GetInstance().GetSubtitleGenerationURL() + subtitleTranscribePath

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	contentType := mw.FormDataContentType()

	go func() {
		werr := func() error {
			af, err := os.Open(audioPath)
			if err != nil {
				return err
			}
			defer af.Close()

			part, err := mw.CreateFormFile("file", filepath.Base(audioPath))
			if err != nil {
				return err
			}
			if _, err := io.Copy(part, af); err != nil {
				return err
			}
			if err := mw.WriteField("prompt", lang); err != nil {
				return err
			}
			return mw.Close()
		}()
		_ = pw.CloseWithError(werr)
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serviceURL, pr)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)

	// no client timeout: transcription of long videos can take minutes;
	// cancellation is handled via the request context.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	return string(body), nil
}

// associateCaption records the generated caption against the video file so it
// is served to the player.
func (t *GenerateSubtitlesTask) associateCaption(ctx context.Context, fileID models.FileID, captionPath, lang string) error {
	return txn.WithTxn(ctx, t.repository.TxnManager, func(ctx context.Context) error {
		captions, err := t.repository.File.GetCaptions(ctx, fileID)
		if err != nil {
			return err
		}

		if video.IsLangInCaptions(lang, "srt", captions) {
			return nil
		}

		captions = append(captions, &models.VideoCaption{
			LanguageCode: lang,
			Filename:     filepath.Base(captionPath),
			CaptionType:  "srt",
		})

		return t.repository.File.UpdateCaptions(ctx, fileID, captions)
	})
}
