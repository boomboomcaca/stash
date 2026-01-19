package subtitle

import "errors"

var (
	ErrWhisperURLEmpty    = errors.New("whisper URL is empty")
	ErrSubtitleDisabled   = errors.New("subtitle service is disabled")
	ErrSubtitleExists     = errors.New("subtitle already exists")
	ErrNoVideoFile        = errors.New("scene has no video file")
	ErrAudioExtractFailed = errors.New("failed to extract audio from video")
	ErrTranscribeFailed   = errors.New("failed to transcribe audio")
	ErrSaveSubtitleFailed = errors.New("failed to save subtitle file")
	ErrWhisperUnavailable = errors.New("whisper service is unavailable")
)
