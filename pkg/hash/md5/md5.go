// Package md5 provides utility functions for generating MD5 hashes.
package md5

import (
	"crypto/md5"
	"fmt"
	"hash"
	"io"
	"os"
)

// FromBytes returns an MD5 checksum string from data.
func FromBytes(data []byte) string {
	result := md5.Sum(data)
	return fmt.Sprintf("%x", result)
}

// FromString returns an MD5 checksum string from str.
func FromString(str string) string {
	data := []byte(str)
	return FromBytes(data)
}

// FromFilePath returns an MD5 checksum string for the file at filePath.
// It returns an empty string and an error if an error occurs opening the file.
func FromFilePath(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	return FromReader(f)
}

// FromReader returns an MD5 checksum string from data read from src.
// It returns an empty string and an error if an error occurs reading from src.
func FromReader(src io.Reader) (string, error) {
	h := md5.New()
	if _, err := io.Copy(h, src); err != nil {
		return "", err
	}
	checksum := h.Sum(nil)
	return fmt.Sprintf("%x", checksum), nil
}

// Hasher incrementally computes an MD5 checksum. Callers that already stream a
// file's bytes for another purpose can Write those bytes here and read the
// checksum via Sum, avoiding a second pass over the file.
type Hasher struct {
	h hash.Hash
}

// NewHasher returns a Hasher ready to accept data via Write.
func NewHasher() *Hasher {
	return &Hasher{h: md5.New()}
}

// Write feeds data into the running checksum. It never returns an error.
func (m *Hasher) Write(p []byte) (int, error) {
	return m.h.Write(p)
}

// Sum returns the hex-encoded MD5 checksum of all data written so far.
func (m *Hasher) Sum() string {
	return fmt.Sprintf("%x", m.h.Sum(nil))
}
