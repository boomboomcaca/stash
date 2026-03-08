package tts

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type EdgeTTS struct{}

func NewEdgeTTS() *EdgeTTS {
	return &EdgeTTS{}
}

// GetPronunciationAudio fetches TTS audio from Microsoft Edge API
func (e *EdgeTTS) GetPronunciationAudio(ctx context.Context, text string, lang string) ([]byte, error) {
	// Map language codes to Edge voices
	// Default to a natural-sounding voice if possible
	voice := e.getVoiceForLang(lang)

	// Microsoft Edge TTS Endpoint
	endpoint := "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4"

	headers := make(http.Header)
	headers.Add("Pragma", "no-cache")
	headers.Add("Cache-Control", "no-cache")
	headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36")
	headers.Add("Origin", "chrome-extension://jdiccldljnbaajokidbeoglbndhlneno")

	dialer := websocket.DefaultDialer
	conn, _, err := dialer.DialContext(ctx, endpoint, headers)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Edge TTS: %w", err)
	}
	defer conn.Close()

	// 1. Send Speech Config
	requestID := strings.ReplaceAll(uuid.New().String(), "-", "")
	timestamp := time.Now().UTC().Format(time.RFC3339)

	configMsg := fmt.Sprintf("X-Timestamp:%s\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{\"context\":{\"system\":{\"name\":\"Edge\",\"version\":\"1.0.0\"},\"os\":{\"platform\":\"Windows\",\"version\":\"10\"},\"browser\":{\"name\":\"Chrome\",\"version\":\"99.0.4844.51\"}}}", timestamp)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(configMsg)); err != nil {
		return nil, fmt.Errorf("failed to send speech config: %w", err)
	}

	// 2. Send SSML
	ssml := fmt.Sprintf(`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='%s'><voice name='%s'><prosody pitch='+0Hz' rate='+0%%' volume='+0%%'>%s</prosody></voice></speak>`, lang, voice, text)
	ssmlMsg := fmt.Sprintf("X-RequestId:%s\r\nX-Timestamp:%s\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n%s", requestID, timestamp, ssml)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(ssmlMsg)); err != nil {
		return nil, fmt.Errorf("failed to send ssml: %w", err)
	}

	var audioData []byte
	for {
		messageType, msg, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure) {
				break
			}
			return nil, fmt.Errorf("failed to read from websocket: %w", err)
		}

		if messageType == websocket.TextMessage {
			msgStr := string(msg)
			if strings.Contains(msgStr, "Path:turn.end") {
				break
			}
			continue
		}

		if messageType == websocket.BinaryMessage {
			// Binary messages in Edge TTS have a 2-byte header indicating the length of the string header
			if len(msg) < 2 {
				continue
			}
			headerLen := int(msg[0])<<8 | int(msg[1])
			if len(msg) < 2+headerLen {
				continue
			}

			header := string(msg[2 : 2+headerLen])
			if strings.Contains(header, "Path:audio") {
				audioData = append(audioData, msg[2+headerLen:]...)
			}
		}
	}

	if len(audioData) == 0 {
		return nil, fmt.Errorf("received no audio data from Edge TTS")
	}

	return audioData, nil
}

func (e *EdgeTTS) getVoiceForLang(lang string) string {
	// Normalize language code
	lang = strings.ToLower(lang)

	// Map to natural Edge voices
	voiceMap := map[string]string{
		"en":    "en-US-GuyNeural",
		"en-us": "en-US-GuyNeural",
		"en-gb": "en-GB-SoniaNeural",
		"zh":    "zh-CN-XiaoxiaoNeural",
		"zh-cn": "zh-CN-XiaoxiaoNeural",
		"zh-hk": "zh-HK-HiuGaaiNeural",
		"zh-tw": "zh-TW-HsiaoChenNeural",
		"es":    "es-ES-ElviraNeural",
		"es-es": "es-ES-ElviraNeural",
		"es-mx": "es-MX-DaliaNeural",
		"fr":    "fr-FR-DeniseNeural",
		"fr-fr": "fr-FR-DeniseNeural",
		"de":    "de-DE-KatjaNeural",
		"de-de": "de-DE-KatjaNeural",
		"ja":    "ja-JP-NanamiNeural",
		"ja-jp": "ja-JP-NanamiNeural",
		"ko":    "ko-KR-SunHiNeural",
		"ko-kr": "ko-KR-SunHiNeural",
		"ru":    "ru-RU-SvetlanaNeural",
		"ru-ru": "ru-RU-SvetlanaNeural",
		"pt":    "pt-BR-FranciscaNeural",
		"pt-br": "pt-BR-FranciscaNeural",
		"pt-pt": "pt-PT-RaquelNeural",
		"it":    "it-IT-ElsaNeural",
		"it-it": "it-IT-ElsaNeural",
	}

	if v, ok := voiceMap[lang]; ok {
		return v
	}

	// Try with just the primary language (e.g. "en" from "en-US")
	if strings.Contains(lang, "-") {
		primaryLang := strings.Split(lang, "-")[0]
		if v, ok := voiceMap[primaryLang]; ok {
			return v
		}
	}

	// Default fallback
	return "en-US-GuyNeural"
}
