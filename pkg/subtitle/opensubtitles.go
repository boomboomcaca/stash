package subtitle

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/stashapp/stash/pkg/logger"
)

const (
	openSubtitlesAPIURL = "https://api.opensubtitles.com/api/v1"
	openSubtitlesUA     = "stash v0.30.1"
)

// OpenSubtitlesClient is a client for the OpenSubtitles API
type OpenSubtitlesClient struct {
	apiKey     string
	httpClient *http.Client
}

// NewOpenSubtitlesClient creates a new OpenSubtitles API client
func NewOpenSubtitlesClient(apiKey string, timeout time.Duration) *OpenSubtitlesClient {
	return &OpenSubtitlesClient{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// SearchResult represents a subtitle search result
type SearchResult struct {
	ID            string
	FileName      string
	Language      string
	DownloadURL   string
	DownloadCount int
	Rating        float64
}

// searchResponse represents the OpenSubtitles API search response
type searchResponse struct {
	TotalPages int `json:"total_pages"`
	TotalCount int `json:"total_count"`
	Data       []struct {
		ID         string `json:"id"`
		Type       string `json:"type"`
		Attributes struct {
			SubtitleID       string  `json:"subtitle_id"`
			Language         string  `json:"language"`
			DownloadCount    int     `json:"download_count"`
			Rating           float64 `json:"ratings"`
			FromTrusted      bool    `json:"from_trusted"`
			ForeignPartsOnly bool    `json:"foreign_parts_only"`
			Files            []struct {
				FileID   int    `json:"file_id"`
				FileName string `json:"file_name"`
			} `json:"files"`
		} `json:"attributes"`
	} `json:"data"`
}

// downloadResponse represents the OpenSubtitles API download response
type downloadResponse struct {
	Link      string `json:"link"`
	FileName  string `json:"file_name"`
	Remaining int    `json:"remaining"`
}

// Search searches for subtitles by file hash
func (c *OpenSubtitlesClient) Search(ctx context.Context, hash string, language string) ([]SearchResult, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("OpenSubtitles API key is not configured")
	}

	// Build search URL
	searchURL, err := url.Parse(openSubtitlesAPIURL + "/subtitles")
	if err != nil {
		return nil, fmt.Errorf("failed to parse URL: %w", err)
	}

	q := searchURL.Query()
	q.Set("moviehash", hash)
	if language != "" {
		q.Set("languages", language)
	}
	searchURL.RawQuery = q.Encode()

	// Create request
	req, err := http.NewRequestWithContext(ctx, "GET", searchURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Api-Key", c.apiKey)
	req.Header.Set("User-Agent", openSubtitlesUA)
	req.Header.Set("Content-Type", "application/json")

	// Send request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("OpenSubtitles API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var searchResp searchResponse
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	// Convert to SearchResult
	var results []SearchResult
	for _, item := range searchResp.Data {
		if len(item.Attributes.Files) == 0 {
			continue
		}
		results = append(results, SearchResult{
			ID:            fmt.Sprintf("%d", item.Attributes.Files[0].FileID),
			FileName:      item.Attributes.Files[0].FileName,
			Language:      item.Attributes.Language,
			DownloadCount: item.Attributes.DownloadCount,
			Rating:        item.Attributes.Rating,
		})
	}

	logger.Debugf("OpenSubtitles search found %d results for hash %s", len(results), hash)
	return results, nil
}

// Download downloads a subtitle file and returns its content
func (c *OpenSubtitlesClient) Download(ctx context.Context, fileID string) ([]byte, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("OpenSubtitles API key is not configured")
	}

	// First, get the download link
	downloadURL := openSubtitlesAPIURL + "/download"

	reqBody := fmt.Sprintf(`{"file_id": %s}`, fileID)
	req, err := http.NewRequestWithContext(ctx, "POST", downloadURL,
		io.NopCloser(stringReader(reqBody)))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Api-Key", c.apiKey)
	req.Header.Set("User-Agent", openSubtitlesUA)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("OpenSubtitles API returned status %d: %s", resp.StatusCode, string(body))
	}

	var dlResp downloadResponse
	if err := json.NewDecoder(resp.Body).Decode(&dlResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	// Download the actual subtitle file
	return c.downloadFile(ctx, dlResp.Link)
}

// downloadFile downloads a file from a URL
func (c *OpenSubtitlesClient) downloadFile(ctx context.Context, fileURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", fileURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to download file: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	// Check if the response is gzipped
	var reader io.Reader = resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		gzReader, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to create gzip reader: %w", err)
		}
		defer gzReader.Close()
		reader = gzReader
	}

	content, err := io.ReadAll(reader)
	if err != nil {
		return nil, fmt.Errorf("failed to read file content: %w", err)
	}

	return content, nil
}

// stringReader creates an io.Reader from a string
func stringReader(s string) io.Reader {
	return &stringReaderImpl{s: s, i: 0}
}

type stringReaderImpl struct {
	s string
	i int
}

func (r *stringReaderImpl) Read(p []byte) (n int, err error) {
	if r.i >= len(r.s) {
		return 0, io.EOF
	}
	n = copy(p, r.s[r.i:])
	r.i += n
	return n, nil
}

// CalculateOSHash calculates the OpenSubtitles hash for a video file
// The hash is computed by taking the first and last 64KB of the file
// and adding them to the file size
func CalculateOSHash(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("failed to stat file: %w", err)
	}

	fileSize := fi.Size()
	if fileSize < 65536*2 {
		return "", fmt.Errorf("file too small for hash calculation")
	}

	// Hash is based on file size
	hash := uint64(fileSize)

	// Read first 64KB
	buf := make([]byte, 65536)
	_, err = file.Read(buf)
	if err != nil {
		return "", fmt.Errorf("failed to read first chunk: %w", err)
	}

	for i := 0; i < 65536/8; i++ {
		hash += readUint64LE(buf[i*8:])
	}

	// Read last 64KB
	_, err = file.Seek(-65536, io.SeekEnd)
	if err != nil {
		return "", fmt.Errorf("failed to seek to end: %w", err)
	}

	_, err = file.Read(buf)
	if err != nil {
		return "", fmt.Errorf("failed to read last chunk: %w", err)
	}

	for i := 0; i < 65536/8; i++ {
		hash += readUint64LE(buf[i*8:])
	}

	return fmt.Sprintf("%016x", hash), nil
}

// readUint64LE reads a little-endian uint64 from a byte slice
func readUint64LE(b []byte) uint64 {
	return uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24 |
		uint64(b[4])<<32 | uint64(b[5])<<40 | uint64(b[6])<<48 | uint64(b[7])<<56
}
