package manager

import (
	"bytes"
	"io"
	"math/rand"
	"testing"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/hash/md5"
	"github.com/stashapp/stash/pkg/hash/oshash"
	"github.com/stashapp/stash/pkg/models"
)

// bytesOpener adapts a byte slice to the file.Opener interface, returning a
// fresh ReadCloser on each Open so callers can read the "file" more than once.
type bytesOpener struct {
	data []byte
}

func (o *bytesOpener) Open() (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(o.data)), nil
}

func makeData(size int) []byte {
	r := rand.New(rand.NewSource(int64(size) + 1))
	b := make([]byte, size)
	_, _ = r.Read(b)
	return b
}

// referenceOshash computes oshash the original way (dedicated seek-based read)
// so the single-pass implementation can be checked against it.
func referenceOshash(t *testing.T, data []byte) string {
	t.Helper()
	got, err := oshash.FromReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("reference oshash: %v", err)
	}
	return got
}

func referenceMD5(t *testing.T, data []byte) string {
	t.Helper()
	got, err := md5.FromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("reference md5: %v", err)
	}
	return got
}

// TestCalculateOshashAndMD5 verifies that the single-pass calculator produces
// exactly the same oshash and MD5 as the standalone implementations, across a
// range of sizes including ones smaller than, equal to, and larger than a
// single oshash chunk.
func TestCalculateOshashAndMD5(t *testing.T) {
	c := &fingerprintCalculator{Config: &config.Config{}}

	chunk := int(oshash.ChunkSize)

	sizes := []int{
		9,             // just above the 8-byte minimum, smaller than a chunk
		1000,          // smaller than a chunk
		chunk,         // exactly one chunk
		chunk + 1,     // just over one chunk
		2 * chunk,     // exactly two chunks (head and tail meet)
		2*chunk + 123, // head and tail don't overlap, with a middle
		5 * chunk,     // several chunks, exercises the sliding tail window
		5*chunk + 777, // several chunks plus a partial final read
	}

	for _, size := range sizes {
		data := makeData(size)
		f := &models.BaseFile{Size: int64(size)}
		o := &bytesOpener{data: data}

		oshashFP, md5FP, err := c.calculateOshashAndMD5(f, o)
		if err != nil {
			t.Fatalf("size %d: unexpected error: %v", size, err)
		}

		wantOshash := referenceOshash(t, data)
		wantMD5 := referenceMD5(t, data)

		if oshashFP.Fingerprint != wantOshash {
			t.Errorf("size %d: oshash = %v, want %v", size, oshashFP.Fingerprint, wantOshash)
		}
		if md5FP.Fingerprint != wantMD5 {
			t.Errorf("size %d: md5 = %v, want %v", size, md5FP.Fingerprint, wantMD5)
		}
		if oshashFP.Type != models.FingerprintTypeOshash {
			t.Errorf("size %d: oshash type = %v", size, oshashFP.Type)
		}
		if md5FP.Type != models.FingerprintTypeMD5 {
			t.Errorf("size %d: md5 type = %v", size, md5FP.Type)
		}
	}
}
