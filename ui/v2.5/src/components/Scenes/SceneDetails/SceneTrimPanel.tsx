import React, { useEffect, useMemo, useState } from "react";
import { Button, Form } from "react-bootstrap";
import * as GQL from "src/core/generated-graphql";
import { useToast } from "src/hooks/Toast";
import { TrimTimeline } from "./TrimTimeline";

interface ISceneTrimPanelProps {
  scene: GQL.SceneDataFragment;
}

interface ICue {
  index: number;
  start: number;
  end: number;
  text: string;
}

// A delete range the user is editing, seeded from a cue but independently adjustable.
interface IRange {
  start: number;
  end: number;
}

// Mirrors ScenePlayer/useSceneLoading buildCaptionTrackSrc: scene.paths.caption
// may already carry a signed-URL query, so pick the correct separator rather
// than always appending "?".
function buildCaptionTrackSrc(
  base: string | null | undefined,
  lang: string,
  type: string
): string {
  const b = base ?? "";
  const sep = b.includes("?") ? "&" : "?";
  return `${b}${sep}lang=${encodeURIComponent(lang)}&type=${encodeURIComponent(
    type
  )}`;
}

// parseTimestamp handles both SRT (HH:MM:SS,mmm) and VTT (HH:MM:SS.mmm), and the
// optional-hours short form (MM:SS.mmm).
function parseTimestamp(s: string): number {
  const m = s
    .trim()
    .replace(",", ".")
    .match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseFloat(m[3]);
  return h * 3600 + min * 60 + sec;
}

// parseSubtitles parses SRT/VTT into time-ordered cues. It ignores headers,
// indices and styling blocks by keying off the "-->" timing line.
function parseSubtitles(text: string): ICue[] {
  const cues: ICue[] = [];
  const body = text.replace(/^﻿/, "");
  const blocks = body.split(/\r?\n\r?\n/);
  let index = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
    const tlIdx = lines.findIndex((l) => l.includes("-->"));
    if (tlIdx < 0) continue;
    const [startStr, endStr] = lines[tlIdx].split("-->");
    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    // strip a leading speaker tag (e.g. "[Speaker 0]: ") for display only;
    // deletion is purely time-based so this is cosmetic.
    const txt = lines
      .slice(tlIdx + 1)
      .join(" ")
      .trim()
      .replace(/^\[[^\]]*\]:\s*/, "");
    cues.push({ index: index++, start, end, text: txt });
  }
  return cues;
}

function fmtTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function clampNonNeg(t: number): number {
  return t < 0 ? 0 : Math.round(t * 1000) / 1000;
}

export const SceneTrimPanel: React.FC<ISceneTrimPanelProps> = ({ scene }) => {
  const Toast = useToast();
  const [sceneTrim, { loading: submitting }] = GQL.useSceneTrimMutation();

  const captions = useMemo(() => scene.captions ?? [], [scene.captions]);
  const captionBase = scene.paths?.caption;
  const duration = scene.files?.[0]?.duration ?? 0;

  const [captionIdx, setCaptionIdx] = useState(0);
  const [cues, setCues] = useState<ICue[]>([]);
  // index -> the (editable) delete range seeded from that cue.
  const [selected, setSelected] = useState<Map<number, IRange>>(new Map());
  const [loadingCues, setLoadingCues] = useState(false);
  const [replace, setReplace] = useState(false);
  const [snapToKeyframes, setSnapToKeyframes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const caption = captions[captionIdx];
    if (!caption || !captionBase) {
      setCues([]);
      return;
    }

    let cancelled = false;
    setLoadingCues(true);
    setError(null);
    setSelected(new Map());

    const url = buildCaptionTrackSrc(
      captionBase,
      caption.language_code,
      caption.caption_type
    );

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        setCues(parseSubtitles(text));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setCues([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCues(false);
      });

    return () => {
      cancelled = true;
    };
  }, [captionBase, captionIdx, captions]);

  // tick/untick a cue — seeds the editable delete range from the cue's own times.
  function toggle(c: ICue) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(c.index)) next.delete(c.index);
      else next.set(c.index, { start: c.start, end: c.end });
      return next;
    });
  }

  // set an absolute value for one edge of a selected range.
  function setEdge(index: number, edge: "start" | "end", value: number) {
    if (Number.isNaN(value)) return;
    setSelected((prev) => {
      const r = prev.get(index);
      if (!r) return prev;
      const next = new Map(prev);
      next.set(index, { ...r, [edge]: clampNonNeg(value) });
      return next;
    });
  }

  // nudge one edge of a selected range by delta seconds.
  function nudge(index: number, edge: "start" | "end", delta: number) {
    setSelected((prev) => {
      const r = prev.get(index);
      if (!r) return prev;
      const next = new Map(prev);
      next.set(index, { ...r, [edge]: clampNonNeg(r[edge] + delta) });
      return next;
    });
  }

  // set a whole range (from the timeline drag).
  function setRange(index: number, r: { start: number; end: number }) {
    setSelected((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Map(prev);
      next.set(index, { start: clampNonNeg(r.start), end: clampNonNeg(r.end) });
      return next;
    });
  }

  function removeRange(index: number) {
    setSelected((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
  }

  const selectedCount = selected.size;
  const totalDeleteSeconds = useMemo(() => {
    let acc = 0;
    selected.forEach((r) => {
      if (r.end > r.start) acc += r.end - r.start;
    });
    return acc;
  }, [selected]);

  async function onTrim() {
    const ranges: IRange[] = [];
    selected.forEach((r) => {
      if (r.end > r.start) ranges.push({ start: r.start, end: r.end });
    });
    if (ranges.length === 0) {
      Toast.error("All selected ranges are empty (end must be after start).");
      return;
    }
    try {
      await sceneTrim({
        variables: {
          id: scene.id,
          deleteRanges: ranges,
          replace,
          snapToKeyframes,
        },
      });
      Toast.success(
        `Trim job started: removing ${ranges.length} segment(s)${
          replace ? " (replacing original)" : " (new .trimmed.mp4)"
        }`
      );
      setSelected(new Map());
    } catch (e) {
      Toast.error(e);
    }
  }

  // inline editor for one edge of a selected range (− / number / +).
  function edgeEditor(index: number, edge: "start" | "end", r: IRange) {
    return (
      <span className="d-inline-flex align-items-center" style={{ gap: 2 }}>
        <Button
          size="sm"
          variant="outline-secondary"
          title="-1 frame (~0.04s)"
          onClick={() => nudge(index, edge, -0.04)}
        >
          ‹
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          title="-0.5s"
          onClick={() => nudge(index, edge, -0.5)}
        >
          −
        </Button>
        <Form.Control
          type="number"
          step={0.1}
          min={0}
          size="sm"
          style={{ width: "6.5em", textAlign: "center" }}
          value={r[edge].toFixed(2)}
          onChange={(e) =>
            setEdge(index, edge, parseFloat(e.currentTarget.value))
          }
        />
        <Button
          size="sm"
          variant="outline-secondary"
          title="+0.5s"
          onClick={() => nudge(index, edge, 0.5)}
        >
          +
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          title="+1 frame (~0.04s)"
          onClick={() => nudge(index, edge, 0.04)}
        >
          ›
        </Button>
      </span>
    );
  }

  return (
    <div className="container scene-trim-panel">
      <h5>Trim by Subtitle</h5>
      <p className="text-muted">
        Tick the subtitle lines to <strong>remove</strong> from the video. Each
        selected line seeds a delete range you can <strong>fine-tune</strong>{" "}
        (the subtitle times rarely match the exact frame you want to cut). The
        remaining parts are joined into a new <code>.trimmed.mp4</code> and the
        captions are re-timed to match. Run this before dubbing.
      </p>

      {captions.length === 0 && (
        <div className="text-warning">
          This scene has no captions yet — generate subtitles first.
        </div>
      )}

      {captions.length > 1 && (
        <Form.Group controlId="scene-trim-caption">
          <Form.Label>Caption track</Form.Label>
          <Form.Control
            as="select"
            value={captionIdx}
            onChange={(e) =>
              setCaptionIdx(parseInt(e.currentTarget.value, 10))
            }
          >
            {captions.map((c, i) => (
              <option key={`${c.language_code}-${c.caption_type}`} value={i}>
                {c.language_code} ({c.caption_type})
              </option>
            ))}
          </Form.Control>
        </Form.Group>
      )}

      {error && (
        <div className="text-danger">Failed to load captions: {error}</div>
      )}
      {loadingCues && <div>Loading subtitles…</div>}

      {cues.length > 0 && (
        <>
          <div className="d-flex justify-content-between align-items-center mb-2">
            <span>
              {selectedCount} / {cues.length} selected
              {selectedCount > 0 &&
                ` · ${fmtTime(totalDeleteSeconds)} to remove`}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSelected(new Map())}
              disabled={selectedCount === 0}
            >
              Clear
            </Button>
          </div>

          {selectedCount > 0 && duration > 0 && (
            <TrimTimeline
              scene={scene}
              duration={duration}
              ranges={selected}
              cueTimes={cues.map((c) => c.start)}
              onChange={setRange}
              onRemove={removeRange}
            />
          )}

          <div
            className="scene-trim-cues"
            style={{
              maxHeight: "50vh",
              overflowY: "auto",
              border: "1px solid rgba(128,128,128,0.4)",
              borderRadius: 4,
            }}
          >
            {cues.map((c) => {
              const sel = selected.get(c.index);
              return (
                <div
                  key={c.index}
                  style={{
                    background: sel ? "rgba(220,53,69,0.18)" : "transparent",
                    borderBottom: "1px solid rgba(128,128,128,0.12)",
                  }}
                >
                  <label
                    className="d-flex align-items-start p-1 mb-0"
                    style={{ cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={!!sel}
                      onChange={() => toggle(c)}
                      className="mr-2 mt-1"
                    />
                    <span
                      className="text-muted mr-2"
                      style={{
                        minWidth: "5.5em",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtTime(c.start)}
                    </span>
                    <span>{c.text}</span>
                  </label>
                  {sel && (
                    <div
                      className="d-flex align-items-center flex-wrap pl-4 pb-2"
                      style={{ gap: "0.4rem", fontVariantNumeric: "tabular-nums" }}
                    >
                      <span className="text-muted small">remove (s):</span>
                      {edgeEditor(c.index, "start", sel)}
                      <span>→</span>
                      {edgeEditor(c.index, "end", sel)}
                      <span className="text-muted small">
                        = {(Math.max(0, sel.end - sel.start)).toFixed(2)}s
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <Form.Check
            type="checkbox"
            id="scene-trim-snap"
            className="mt-3"
            label="Snap cut points to nearest keyframe (cleaner seams, faster — gives up a little precision)"
            checked={snapToKeyframes}
            onChange={(e) => setSnapToKeyframes(e.currentTarget.checked)}
          />

          <Form.Check
            type="checkbox"
            id="scene-trim-replace"
            className="mt-1"
            label="Replace the original file (otherwise write a new .trimmed.mp4)"
            checked={replace}
            onChange={(e) => setReplace(e.currentTarget.checked)}
          />

          <Button
            variant="danger"
            className="mt-2"
            disabled={selectedCount === 0 || submitting}
            onClick={onTrim}
          >
            {submitting
              ? "Starting…"
              : `Trim — remove ${selectedCount} segment${
                  selectedCount === 1 ? "" : "s"
                }`}
          </Button>
        </>
      )}
    </div>
  );
};

export default SceneTrimPanel;
