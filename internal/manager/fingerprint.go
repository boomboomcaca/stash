package manager

import (
	"errors"
	"fmt"
	"io"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/file"
	"github.com/stashapp/stash/pkg/hash/md5"
	"github.com/stashapp/stash/pkg/hash/oshash"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
)

type fingerprintCalculator struct {
	Config *config.Config
}

func (c *fingerprintCalculator) calculateOshash(f *models.BaseFile, o file.Opener) (*models.Fingerprint, error) {
	r, err := o.Open()
	if err != nil {
		return nil, fmt.Errorf("opening file: %w", err)
	}

	defer r.Close()

	rc, isRC := r.(io.ReadSeeker)
	if !isRC {
		return nil, errors.New("cannot calculate oshash for non-readcloser")
	}

	hash, err := oshash.FromReader(rc, f.Size)
	if err != nil {
		return nil, fmt.Errorf("calculating oshash: %w", err)
	}

	return &models.Fingerprint{
		Type:        models.FingerprintTypeOshash,
		Fingerprint: hash,
	}, nil
}

func (c *fingerprintCalculator) calculateMD5(o file.Opener) (*models.Fingerprint, error) {
	r, err := o.Open()
	if err != nil {
		return nil, fmt.Errorf("opening file: %w", err)
	}

	defer r.Close()

	hash, err := md5.FromReader(r)
	if err != nil {
		return nil, fmt.Errorf("calculating md5: %w", err)
	}

	return &models.Fingerprint{
		Type:        models.FingerprintTypeMD5,
		Fingerprint: hash,
	}, nil
}

// calculateOshashAndMD5 computes both the oshash and MD5 fingerprints in a
// single sequential pass over the file. oshash only needs the head and tail
// chunks, but MD5 requires the whole file; rather than opening and reading the
// file twice (once for each), we stream it once through the MD5 hasher while
// capturing the head/tail bytes oshash needs. For large videos this halves the
// I/O of the previous two-Open approach.
func (c *fingerprintCalculator) calculateOshashAndMD5(f *models.BaseFile, o file.Opener) (oshashFP *models.Fingerprint, md5FP *models.Fingerprint, err error) {
	r, err := o.Open()
	if err != nil {
		return nil, nil, fmt.Errorf("opening file: %w", err)
	}
	defer r.Close()

	size := f.Size
	if size <= 8 {
		return nil, nil, fmt.Errorf("cannot calculate oshash where size < 8 (%d)", size)
	}

	chunk := oshash.FileChunkSize(size)
	head := make([]byte, chunk)
	tail := make([]byte, chunk)

	h := md5.NewHasher()

	// Read the whole file once, feeding every byte to MD5 while retaining the
	// first `chunk` bytes as the head and keeping a sliding window of the last
	// `chunk` bytes as the tail.
	var read int64
	buf := make([]byte, 64*1024)
	tailFilled := int64(0)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			if _, werr := h.Write(buf[:n]); werr != nil {
				return nil, nil, fmt.Errorf("hashing md5: %w", werr)
			}

			// capture head bytes
			if read < chunk {
				toCopy := chunk - read
				if int64(n) < toCopy {
					toCopy = int64(n)
				}
				copy(head[read:read+toCopy], buf[:toCopy])
			}

			// maintain the last `chunk` bytes as tail using a sliding window
			if int64(n) >= chunk {
				copy(tail, buf[int64(n)-chunk:n])
				tailFilled = chunk
			} else {
				keep := chunk - int64(n)
				if keep > tailFilled {
					keep = tailFilled
				}
				copy(tail, tail[tailFilled-keep:tailFilled])
				copy(tail[keep:], buf[:n])
				tailFilled = keep + int64(n)
			}

			read += int64(n)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, nil, fmt.Errorf("reading file: %w", rerr)
		}
	}

	if read < chunk {
		return nil, nil, fmt.Errorf("file smaller than expected (%d < %d)", read, chunk)
	}

	oshashValue, err := oshash.FromHeadTail(size, head, tail)
	if err != nil {
		return nil, nil, fmt.Errorf("calculating oshash: %w", err)
	}

	return &models.Fingerprint{
			Type:        models.FingerprintTypeOshash,
			Fingerprint: oshashValue,
		}, &models.Fingerprint{
			Type:        models.FingerprintTypeMD5,
			Fingerprint: h.Sum(),
		}, nil
}

func (c *fingerprintCalculator) CalculateFingerprints(f *models.BaseFile, o file.Opener, useExisting bool) ([]models.Fingerprint, error) {
	var ret []models.Fingerprint
	calculateMD5 := true

	if useAsVideo(f.Path) {
		var (
			oshashFP *models.Fingerprint
			err      error
		)

		if useExisting {
			oshashFP = f.Fingerprints.For(models.FingerprintTypeOshash)
		}

		// only calculate MD5 if enabled in config
		calculateMD5 = c.Config.IsCalculateMD5()

		var existingMD5 *models.Fingerprint
		if useExisting && calculateMD5 {
			existingMD5 = f.Fingerprints.For(models.FingerprintTypeMD5)
		}

		// If both oshash and md5 need calculating, do it in a single read pass.
		if oshashFP == nil && calculateMD5 && existingMD5 == nil {
			if useExisting {
				logger.Infof("Calculating checksum for %s ...", f.Path)
			}

			var md5FP *models.Fingerprint
			oshashFP, md5FP, err = c.calculateOshashAndMD5(f, o)
			if err != nil {
				return nil, err
			}
			return append(ret, *oshashFP, *md5FP), nil
		}

		if oshashFP == nil {
			// calculate oshash only
			oshashFP, err = c.calculateOshash(f, o)
			if err != nil {
				return nil, err
			}
		}

		ret = append(ret, *oshashFP)

		// md5 is either not needed, reused from existing, or handled below
		if calculateMD5 {
			if existingMD5 != nil {
				return append(ret, *existingMD5), nil
			}
			if useExisting {
				logger.Infof("Calculating checksum for %s ...", f.Path)
			}
			md5FP, err := c.calculateMD5(o)
			if err != nil {
				return nil, err
			}
			ret = append(ret, *md5FP)
		}

		return ret, nil
	}

	if calculateMD5 {
		var (
			fp  *models.Fingerprint
			err error
		)

		if useExisting {
			fp = f.Fingerprints.For(models.FingerprintTypeMD5)
		}

		if fp == nil {
			if useExisting {
				// log to indicate missing fingerprint is being calculated
				logger.Infof("Calculating checksum for %s ...", f.Path)
			}

			fp, err = c.calculateMD5(o)
			if err != nil {
				return nil, err
			}
		}

		ret = append(ret, *fp)
	}

	return ret, nil
}
