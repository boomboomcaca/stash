import test from "node:test";
import assert from "node:assert/strict";
import {
  computeIsMobilePortrait,
  calculateMaxOffset,
  clampOffset,
  STORAGE_KEY,
} from "./useMobilePortraitDrag";

test("STORAGE_KEY has expected identifier", () => {
  assert.equal(STORAGE_KEY, "stash-mobile-portrait-video-offset");
});

test("computeIsMobilePortrait detects mobile portrait mode accurately", () => {
  // Mobile phone in portrait (width < 1200 and height > width)
  assert.equal(computeIsMobilePortrait(390, 844), true);
  assert.equal(computeIsMobilePortrait(414, 896), true);
  assert.equal(computeIsMobilePortrait(375, 667), true);

  // Tablet in portrait
  assert.equal(computeIsMobilePortrait(768, 1024), true);

  // Mobile phone in landscape (height < width) -> should be false
  assert.equal(computeIsMobilePortrait(844, 390), false);
  assert.equal(computeIsMobilePortrait(896, 414), false);

  // Desktop (width >= 1200) -> should be false regardless of aspect ratio
  assert.equal(computeIsMobilePortrait(1920, 1080), false);
  assert.equal(computeIsMobilePortrait(1440, 900), false);
  assert.equal(computeIsMobilePortrait(1200, 1600), false);
});

test("calculateMaxOffset ensures player does not exceed top or bottom boundaries", () => {
  // iPhone 14 (viewport 844), player height 300, baseTop 50, bottomPadding 12
  // MaxOffset = 844 - 12 - 50 - 300 = 482
  assert.equal(calculateMaxOffset(844, 300, 50, 12), 482);

  // Default parameters fallback
  assert.equal(calculateMaxOffset(844), 844 - 12 - 0 - 280);

  // When player height equals or exceeds available space, maxOffset should be 0
  assert.equal(calculateMaxOffset(600, 600, 50, 12), 0);
  assert.equal(calculateMaxOffset(300, 400, 0, 12), 0);
});

test("clampOffset correctly constrains offset within [minOffset, maxOffset]", () => {
  const maxOffset = 400;
  // Normal value within range
  assert.equal(clampOffset(150, maxOffset), 150);
  assert.equal(clampOffset(0, maxOffset), 0);
  assert.equal(clampOffset(400, maxOffset), 400);

  // Negative value clamped to 0 (cannot exceed top)
  assert.equal(clampOffset(-50, maxOffset), 0);
  assert.equal(clampOffset(-1, maxOffset), 0);

  // Excessive value clamped to maxOffset (cannot exceed bottom)
  assert.equal(clampOffset(450, maxOffset), 400);
  assert.equal(clampOffset(1000, maxOffset), 400);

  // Explicit minOffset
  assert.equal(clampOffset(10, 400, 30), 30);
});
