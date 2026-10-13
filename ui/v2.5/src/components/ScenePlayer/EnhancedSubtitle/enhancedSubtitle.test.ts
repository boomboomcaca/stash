import test from "node:test";
import assert from "node:assert/strict";
import { parseVTTTime, parseVTTContent } from "./hooks/useSubtitleParser";
import { createSegmenter, detectLanguage } from "./segmentation";

test("parseVTTTime parses standard hh:mm:ss.ttt format", () => {
  const result = parseVTTTime("01:02:03.500");
  assert.equal(result, 1 * 3600 + 2 * 60 + 3.5);
});

test("parseVTTTime parses mm:ss.ttt format (no hours)", () => {
  const result = parseVTTTime("05:20.125");
  assert.equal(result, 5 * 60 + 20.125);
});

test("parseVTTTime handles comma as millisecond separator", () => {
  const resultWithHours = parseVTTTime("00:01:23,456");
  assert.equal(resultWithHours, 83.456);

  const resultNoHours = parseVTTTime("01:23,456");
  assert.equal(resultNoHours, 83.456);
});

test("parseVTTContent parses standard and flexible WebVTT tracks", () => {
  const sampleVtt = `WEBVTT
NOTE This is a comment

1
00:00:01.000 --> 00:00:03.500
Hello <b>world</b>!

2
00:04.100 --> 00:06.800 position:10%
Second cue without hours.

3
00:01:10,250 --> 00:01:12,500
Third cue with comma.
Multi-line subtitle text.
`;

  const cues = parseVTTContent(sampleVtt);
  assert.equal(cues.length, 3);

  // Cue 1
  assert.equal(cues[0].startTime, 1);
  assert.equal(cues[0].endTime, 3.5);
  assert.equal(cues[0].text, "Hello world!");

  // Cue 2
  assert.equal(cues[1].startTime, 4.1);
  assert.equal(cues[1].endTime, 6.8);
  assert.equal(cues[1].text, "Second cue without hours.");

  // Cue 3
  assert.equal(cues[2].startTime, 70.25);
  assert.equal(cues[2].endTime, 72.5);
  assert.equal(
    cues[2].text,
    "Third cue with comma.\nMulti-line subtitle text."
  );
});

test("detectLanguage recognizes English, Chinese, and bilingual lines", () => {
  assert.equal(detectLanguage("Hello, how are you?"), "en");
  assert.equal(detectLanguage("你好，世界！"), "zh");
  // Bilingual subtitles should prioritize Latin so English words can be segmented
  assert.equal(detectLanguage("Hello world\n你好，世界！"), "en");
});

test("createSegmenter segments English words and contractions properly", () => {
  const segmenter = createSegmenter({ language: "en" });
  const segments = segmenter.segmentText("Don't worry, it's totally fine!");

  const words = segments.map((s) => s.word);
  assert.ok(words.includes("Don't"));
  assert.ok(words.includes("worry"));
  assert.ok(words.includes("it's"));
  assert.ok(words.includes("totally"));
  assert.ok(words.includes("fine"));
});

test("createSegmenter does not produce empty words for whitespace", () => {
  const segmenter = createSegmenter({ language: "en" });
  const segments = segmenter.segmentText("   \n\t  ");
  assert.equal(segments.length, 0);
});
