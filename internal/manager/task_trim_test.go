package manager

import (
	"reflect"
	"testing"
)

func TestComputeKeepIntervals(t *testing.T) {
	tests := []struct {
		name     string
		del      []TimeRange
		duration float64
		want     []TimeRange
		wantErr  bool
	}{
		{"middle", []TimeRange{{10, 20}}, 100, []TimeRange{{0, 10}, {20, 100}}, false},
		{"intro", []TimeRange{{0, 10}}, 100, []TimeRange{{10, 100}}, false},
		{"outro", []TimeRange{{90, 100}}, 100, []TimeRange{{0, 90}}, false},
		{"two", []TimeRange{{10, 20}, {50, 60}}, 100, []TimeRange{{0, 10}, {20, 50}, {60, 100}}, false},
		{"overlap merged", []TimeRange{{10, 25}, {20, 30}}, 100, []TimeRange{{0, 10}, {30, 100}}, false},
		{"unsorted", []TimeRange{{50, 60}, {10, 20}}, 100, []TimeRange{{0, 10}, {20, 50}, {60, 100}}, false},
		{"clamp over-end", []TimeRange{{90, 999}}, 100, []TimeRange{{0, 90}}, false},
		{"covers all", []TimeRange{{0, 100}}, 100, nil, true},
		{"empty range", []TimeRange{{5, 5}}, 100, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := computeKeepIntervals(tt.del, tt.duration)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
}

func TestDeletedBefore(t *testing.T) {
	ranges := []TimeRange{{10, 20}, {50, 60}}
	cases := []struct {
		sec  float64
		want float64
	}{
		{5, 0}, {15, 0}, {25, 10}, {55, 10}, {70, 20},
	}
	for _, c := range cases {
		if got := deletedBefore(c.sec, ranges); got != c.want {
			t.Errorf("deletedBefore(%v)=%v want %v", c.sec, got, c.want)
		}
	}
}

func TestInAnyRange(t *testing.T) {
	ranges := []TimeRange{{10, 20}}
	if !inAnyRange(15, ranges) {
		t.Error("15 should be in range")
	}
	if inAnyRange(20, ranges) {
		t.Error("20 should NOT be in range (exclusive end)")
	}
	if inAnyRange(5, ranges) {
		t.Error("5 should not be in range")
	}
}

func TestPlanSmartcutSegments(t *testing.T) {
	kf := []float64{0, 5, 10, 15, 20, 25, 30}
	approx := func(a, b float64) bool { return a-b < 1e-6 && b-a < 1e-6 }
	eqSegs := func(got, want []trimSeg) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if !approx(got[i].start, want[i].start) || !approx(got[i].dur, want[i].dur) || got[i].copy != want[i].copy {
				return false
			}
		}
		return true
	}
	tests := []struct {
		name string
		keep []TimeRange
		kf   []float64
		want []trimSeg
	}{
		// re-encode the [3,5) head and [20,22) tail, stream-copy the [5,20) middle
		{"head-mid-tail", []TimeRange{{3, 22}}, kf, []trimSeg{{3, 2, false}, {5, 15, true}, {20, 2, false}}},
		// both ends already on keyframes -> pure copy, no re-encode
		{"aligned both ends", []TimeRange{{5, 20}}, kf, []trimSeg{{5, 15, true}}},
		// no keyframe inside -> whole interval re-encoded
		{"no keyframe inside", []TimeRange{{11, 14}}, kf, []trimSeg{{11, 3, false}}},
		// a single keyframe gives no copyable GOP -> whole interval re-encoded
		{"single keyframe inside", []TimeRange{{8, 12}}, kf, []trimSeg{{8, 4, false}}},
		// keyframes unavailable -> fall back to full re-encode
		{"no keyframes at all", []TimeRange{{3, 22}}, nil, []trimSeg{{3, 19, false}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := planSmartcutSegments(tt.keep, tt.kf)
			if !eqSegs(got, tt.want) {
				t.Fatalf("got %+v want %+v", got, tt.want)
			}
		})
	}
}
